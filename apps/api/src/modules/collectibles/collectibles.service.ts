import {
  AlgorandTransactionStatus,
  CollectibleBase,
  CollectibleListQuerystring,
  CollectibleListShowcase,
  CollectibleListWithTotal,
  CollectiblesByAlgoAddressQuerystring,
  CollectibleShowcaseQuerystring,
  CollectibleSortField,
  CollectibleWithDetails,
  DEFAULT_LOCALE,
  EventAction,
  EventEntityType,
  ExportCollectible,
  IPFSStatus,
  SingleCollectibleQuerystring,
  SortDirection,
} from '@algomart/schemas'
import { Transaction } from 'objection'

import { Configuration } from '@/configuration'
import AlgoExplorerAdapter from '@/lib/algoexplorer-adapter'
import AlgorandAdapter, {
  DEFAULT_INITIAL_BALANCE,
} from '@/lib/algorand-adapter'
import DirectusAdapter, { ItemFilter } from '@/lib/directus-adapter'
import NFTStorageAdapter from '@/lib/nft-storage-adapter'
import { AlgorandAccountModel } from '@/models/algorand-account.model'
import { AlgorandTransactionModel } from '@/models/algorand-transaction.model'
import { CollectibleModel } from '@/models/collectible.model'
import { CollectibleOwnershipModel } from '@/models/collectible-ownership.model'
import { CollectibleShowcaseModel } from '@/models/collectible-showcase.model'
import { EventModel } from '@/models/event.model'
import { UserAccountModel } from '@/models/user-account.model'
import { isDefinedArray } from '@/utils/arrays'
import { addDays, isBeforeNow } from '@/utils/date-time'
import { invariant, userInvariant } from '@/utils/invariant'
import { logger } from '@/utils/logger'

const MAX_SHOWCASES = 8

export default class CollectiblesService {
  logger = logger.child({ context: this.constructor.name })

  constructor(
    private readonly cms: DirectusAdapter,
    private readonly algorand: AlgorandAdapter,
    private readonly storage: NFTStorageAdapter,
    private readonly algoExplorer: AlgoExplorerAdapter
  ) {}

  async generateCollectibles(limit = 5, trx?: Transaction) {
    const existingTemplates = await CollectibleModel.query(trx)
      .groupBy('templateId')
      .select('templateId')
    const filter: ItemFilter = {}
    if (existingTemplates.length > 0) {
      filter.id = {
        _nin: existingTemplates.map((c) => c.templateId),
      }
    }
    const { collectibles: templates } = await this.cms.findAllCollectibles(
      undefined,
      filter,
      limit
    )
    if (templates.length === 0) {
      return 0
    }

    const collectibles = await CollectibleModel.query(trx).insert(
      templates.flatMap((t) =>
        Array.from({ length: t.totalEditions }, (_, index) => ({
          edition: index + 1,
          templateId: t.templateId,
        }))
      )
    )

    await EventModel.query(trx).insert(
      collectibles.flatMap((c) => ({
        action: EventAction.Create,
        entityType: EventEntityType.Collectible,
        entityId: c.id,
      }))
    )

    return collectibles.length
  }

  getTransferrableAt(collectible: CollectibleModel): Date {
    invariant(collectible.pack, 'must load collectible with its pack')
    invariant(
      collectible.creationTransaction,
      'must load collectible with its creation transaction'
    )

    const { payment } = collectible.pack

    // If this collectible was purchased with a card, then it cannot be
    // transferred until MINIMUM_DAYS_BEFORE_TRANSFER has passed since the
    // ASA was minted.
    const wasPaidWithCard =
      payment && !payment.destinationAddress && !payment.paymentBankId

    const transferrableAt = wasPaidWithCard
      ? addDays(
          new Date(collectible.creationTransaction.createdAt),
          Configuration.minimumDaysBeforeTransfer
        )
      : new Date(collectible.creationTransaction.createdAt)

    return transferrableAt
  }

  async getCollectible(
    query: SingleCollectibleQuerystring
  ): Promise<CollectibleWithDetails> {
    const collectible = await CollectibleModel.query()
      .findOne({ address: query.assetId })
      .withGraphFetched('[creationTransaction, pack.payment]')

    userInvariant(collectible, 'Collectible not found', 404)

    const transferrableAt = this.getTransferrableAt(collectible)

    const {
      collectibles: [template],
    } = await this.cms.findAllCollectibles(
      query.locale,
      {
        id: { _eq: collectible.templateId },
      },
      1
    )

    invariant(template, `NFT Template ${collectible.templateId} not found`)

    const currentOwner = await this.algoExplorer.getCurrentAssetOwner(
      collectible.address
    )
    const owner = await UserAccountModel.query()
      .alias('u')
      .join('AlgorandAccount as a', 'u.algorandAccountId', 'a.id')
      .where('a.address', '=', currentOwner?.address || '-')
      .first()

    const { collections } = await this.cms.findAllCollections(query.locale)
    const collection = collections.find(
      (c) =>
        c.id === template.collectionId ||
        c.sets.some((s) => s.id === template.setId)
    )
    const set = collection?.sets.find((s) => s.id === template.setId)

    return {
      ...template,
      set,
      collection,
      currentOwner: owner?.username,
      currentOwnerAddress: currentOwner?.address,
      isFrozen: currentOwner?.assets.some(
        (asset) =>
          asset['asset-id'] === collectible.address && asset['is-frozen']
      ),
      transferrableAt: transferrableAt.toISOString(),
      id: collectible.id,
      edition: collectible.edition,
      address: collectible.address,
      mintedAt: collectible.creationTransaction?.createdAt,
      claimedAt:
        collectible.claimedAt instanceof Date
          ? collectible.claimedAt.toISOString()
          : collectible.claimedAt,
    }
  }

  async storeCollectibles(limit = 5, trx: Transaction) {
    // Get unstored collectibles
    const collectibles = await CollectibleModel.query(trx)
      .whereNull('ipfsStatus')
      .orderBy('templateId')
      .limit(10)

    if (collectibles.length === 0) {
      return 0
    }

    // Group collectibles into a map, keyed by their template ID
    const collectiblesLookupByTemplate = new Map<string, CollectibleModel[]>(
      collectibles.map((c) => [
        c.templateId,
        collectibles.filter(({ templateId }) => templateId === c.templateId),
      ])
    )

    // Get corresponding templates from CMS
    const { collectibles: templates } = await this.cms.findAllCollectibles(
      undefined,
      { id: { _in: [...collectiblesLookupByTemplate.keys()] } },
      limit
    )

    if (templates.length === 0) {
      return 0
    }

    // Grouping collectibles by template data prevents need to upload assets more than once
    await Promise.all(
      templates.map(
        async (t) =>
          await this.storeCollectiblesByTemplate(
            t,
            collectiblesLookupByTemplate.get(t.templateId) || [],
            trx
          )
      )
    )

    return collectibles.length
  }

  async getCollectiblesByAlgoAddress(
    algoAddress: string,
    {
      locale = DEFAULT_LOCALE,
      page = 1,
      pageSize = 10,
      sortBy = CollectibleSortField.Title,
      sortDirection = SortDirection.Ascending,
    }: CollectiblesByAlgoAddressQuerystring
  ): Promise<CollectibleListWithTotal | null> {
    // Validate query
    userInvariant(page > 0, 'page must be greater than 0')
    userInvariant(
      pageSize > 0 || pageSize === -1,
      'pageSize must be greater than 0'
    )
    userInvariant(
      [CollectibleSortField.ClaimedAt, CollectibleSortField.Title].includes(
        sortBy
      ),
      'sortBy must be one of claimedAt or title'
    )
    userInvariant(
      [SortDirection.Ascending, SortDirection.Descending].includes(
        sortDirection
      ),
      'sortDirection must be one of asc or desc'
    )

    // Get assets on the requested address
    const { assets } = await this.algoExplorer.getAccount(algoAddress)

    // Find corresponding assets in DB
    const collectibles = await CollectibleModel.query().whereIn(
      'address',
      assets.map((a) => a['asset-id'])
    )

    if (collectibles.length === 0) {
      return {
        collectibles: [],
        total: 0,
      }
    }

    // Get corresponding templates from CMS
    const templateIds = [...new Set(collectibles.map((c) => c.templateId))]
    const { collectibles: templates } = await this.cms.findAllCollectibles(
      locale,
      { id: { _in: templateIds } }
    )

    // Map and sort collectibles
    const templateLookup = new Map(templates.map((t) => [t.templateId, t]))
    const mappedCollectibles = collectibles
      .map((c) => {
        const template = templateLookup.get(c.templateId)
        invariant(template !== undefined, `template ${c.templateId} not found`)

        return {
          ...template,
          claimedAt:
            c.claimedAt instanceof Date
              ? c.claimedAt.toISOString()
              : c.claimedAt,
          id: c.id,
          address: c.address,
          edition: c.edition,
        } as CollectibleWithDetails
      })
      .sort((a, b) => {
        const direction = sortDirection === SortDirection.Ascending ? 1 : -1
        return direction * (a[sortBy] || '').localeCompare(b[sortBy] || '')
      })

    // Slice for pagination
    const collectiblesPage =
      pageSize === -1
        ? mappedCollectibles
        : mappedCollectibles.slice((page - 1) * pageSize, page * pageSize)

    return {
      total: mappedCollectibles.length,
      collectibles: collectiblesPage,
    }
  }

  async storeCollectiblesByTemplate(
    template: CollectibleBase,
    collectibles: CollectibleModel[],
    trx: Transaction
  ) {
    await CollectibleModel.query()
      .whereIn(
        'id',
        collectibles.map((c) => c.id)
      )
      .patch({ ipfsStatus: IPFSStatus.Pending })

    try {
      // Store template's media assets
      const imageData = await this.storage.storeFile(template.image)
      const animationField: string | undefined =
        template.assetFile || template.previewVideo || template.previewAudio
      const animationData = animationField
        ? await this.storage.storeFile(animationField)
        : null

      await Promise.all(
        collectibles.map(async (c) => {
          const metadata = this.storage.mapToMetadata({
            ...(animationData && {
              animation_integrity: animationData.integrityHash,
              animation_url_mimetype: animationData.mimeType,
              animation_url: animationData.uri,
            }),
            description: template.subtitle,
            editionNumber: c.edition,
            image_integrity: imageData.integrityHash,
            image_mimetype: imageData.mimeType,
            image: imageData.uri,
            name: template.uniqueCode,
            totalEditions: template.totalEditions,
          })

          // Store metadata as JSON on IPFS
          const assetUrl = await this.storage.storeJSON(metadata)

          // Construct JSON hash of metadata
          const assetMetadataHash = this.storage.hashMetadata(metadata)

          await CollectibleModel.query(trx).where('id', c.id).patch({
            assetUrl,
            assetMetadataHash,
            ipfsStatus: IPFSStatus.Stored,
          })
          await EventModel.query(trx).insert({
            action: EventAction.Update,
            entityType: EventEntityType.Collectible,
            entityId: c.id,
          })
        })
      )
    } catch (error) {
      await CollectibleModel.query()
        .whereIn(
          'id',
          collectibles.map((c) => c.id)
        )
        .patch({ ipfsStatus: null })
      throw error
    }
  }

  async getCollectiblesByPackId(packId: string, trx?: Transaction) {
    return await CollectibleModel.query(trx).where('packId', packId)
  }

  async mintCollectibles(trx?: Transaction) {
    const collectibles = await CollectibleModel.query(trx)
      .whereNull('creationTransactionId')
      .joinRelated('pack', { alias: 'p' })
      .whereNotNull('p.ownerId')
      .limit(16)

    // No collectibles matched the IDs or they are all already minted
    if (collectibles.length === 0) return 0

    const templateIds = [...new Set(collectibles.map((c) => c.templateId))]

    const { collectibles: templates } = await this.cms.findAllCollectibles(
      undefined,
      {
        id: {
          _in: templateIds,
        },
      }
    )

    invariant(templates.length > 0, 'templates not found')

    // TODO: remove the creator account once the 1000 asset limit is removed
    const initialBalance =
      DEFAULT_INITIAL_BALANCE +
      // 0.1 ALGO per collectible
      collectibles.length * 100_000 +
      // 1000 microAlgos per create transaction
      collectibles.length * 1000
    const creator = await this.algorand.getCreatorAccount(initialBalance)

    const transactions = await AlgorandTransactionModel.query(trx).insert([
      {
        // funding transaction
        address: creator.transactionIds[0],
        // Creator must already be confirmed for us to get here
        status: AlgorandTransactionStatus.Confirmed,
      },
      {
        // non-participation transaction
        address: creator.transactionIds[1],
        status: AlgorandTransactionStatus.Pending,
      },
    ])

    const creatorAccount = await AlgorandAccountModel.query(trx).insertGraph(
      {
        address: creator.address,
        encryptedKey: creator.encryptedMnemonic,
        creationTransactionId: transactions[0].id,
      },
      { relate: true }
    )

    await EventModel.query(trx).insert({
      action: EventAction.Create,
      entityType: EventEntityType.AlgorandAccount,
      entityId: creatorAccount.id,
    })

    const { signedTransactions, transactionIds } =
      await this.algorand.generateCreateAssetTransactions(
        collectibles,
        templates,
        creator
      )

    this.logger.info('Using creator account %s', creator?.address || '-')

    try {
      await this.algorand.submitTransaction(signedTransactions)
    } catch (error) {
      if (creator) {
        this.logger.info('Closing creator account %s', creator.address)
        await this.algorand.closeCreatorAccount(creator)
      }
      throw error
    }

    await Promise.all(
      collectibles.map(async (collectible, index) => {
        return await CollectibleModel.query(trx).upsertGraph(
          {
            id: collectible.id,
            creationTransaction: {
              address: transactionIds[index],
              status: AlgorandTransactionStatus.Pending,
            },
          },
          { relate: true }
        )
      })
    )

    const createdTransactions = await AlgorandTransactionModel.query(trx)
      .whereIn('address', transactionIds)
      .select('id')

    await EventModel.query(trx).insert([
      ...collectibles.map((collectible) => ({
        action: EventAction.Update,
        entityType: EventEntityType.Collectible,
        entityId: collectible.id,
      })),
      ...createdTransactions.map((t) => ({
        action: EventAction.Create,
        entityType: EventEntityType.AlgorandTransaction,
        entityId: t.id,
      })),
    ])

    return collectibles.length
  }

  async transferToUserFromCreator(
    id: string,
    userId: string,
    passphrase: string,
    trx?: Transaction
  ) {
    const collectible = await CollectibleModel.query(trx).findById(id)
    const user = await UserAccountModel.query(trx)
      .findById(userId)
      .withGraphFetched('algorandAccount')

    userInvariant(user, 'user account not found', 404)
    userInvariant(collectible, 'collectible not found', 404)

    const encryptedMnemonic = user.algorandAccount?.encryptedKey
    const assetIndex = collectible.address

    if (!encryptedMnemonic) {
      throw new Error('User missing algorand account')
    }

    if (!assetIndex) {
      throw new Error('Collectible not yet minted')
    }

    const info = await this.algorand.getAssetInfo(assetIndex)

    if (!info) {
      throw new Error(
        `Collectible with asset index ${assetIndex} not found on blockchain`
      )
    }

    const { signedTransactions, transactionIds } =
      await this.algorand.generateClawbackTransactions({
        assetIndex,
        encryptedMnemonic,
        passphrase,
        fromAccountAddress: info.creator,
      })

    await this.algorand.submitTransaction(signedTransactions)

    const transactions = await AlgorandTransactionModel.query(trx).insert(
      transactionIds.map((id) => ({
        address: id,
        status: AlgorandTransactionStatus.Pending,
      }))
    )

    await CollectibleModel.query(trx).where('id', collectible.id).patch({
      ownerId: userId,
      latestTransferTransactionId: transactions[0].id,
      claimedAt: new Date().toISOString(),
    })

    const ownership = await CollectibleOwnershipModel.query(trx).insert({
      collectibleId: collectible.id,
      ownerId: userId,
    })

    await EventModel.query(trx).insert([
      ...transactions.map((t) => ({
        action: EventAction.Create,
        entityType: EventEntityType.AlgorandTransaction,
        entityId: t.id,
        userAccountId: userId,
      })),
      {
        action: EventAction.Update,
        entityId: collectible.id,
        entityType: EventEntityType.Collectible,
        userAccountId: userId,
      },
      {
        action: EventAction.Create,
        entityId: ownership.id,
        entityType: EventEntityType.CollectibleOwnership,
        userAccountId: userId,
      },
    ])
  }

  async transferToCreatorFromUser(
    id: string,
    accountAddress?: string,
    userId?: string,
    trx?: Transaction
  ) {
    userInvariant(userId || accountAddress, 'identifier not provided', 400)

    const collectible = await CollectibleModel.query(trx).findById(id)
    userInvariant(collectible, 'collectible not found', 404)

    // Find the user to get the address IF the user ID was provided
    let userAddress: string = accountAddress
    if (userId) {
      const user = await UserAccountModel.query(trx)
        .findById(userId)
        .withGraphFetched('algorandAccount')
      userInvariant(user, 'user account not found', 404)
      userAddress = user.algorandAccount.address
    }
    userInvariant(userAddress, 'address not found for user', 400)

    const assetIndex = collectible.address
    if (!assetIndex) {
      throw new Error('Collectible not yet minted')
    }

    const info = await this.algorand.getAssetInfo(assetIndex)

    if (!info) {
      throw new Error(
        `Collectible with asset index ${assetIndex} not found on blockchain`
      )
    }

    const { signedTransactions, transactionIds } =
      await this.algorand.generateClawbackTransactionsFromUser({
        assetIndex,
        fromAccountAddress: userAddress,
        toAccountAddress: info.creator,
      })

    await this.algorand.submitTransaction(signedTransactions)

    const transactions = await AlgorandTransactionModel.query(trx).insert(
      transactionIds.map((id) => ({
        address: id,
        status: AlgorandTransactionStatus.Pending,
      }))
    )

    // Remove ownership from collectible
    await CollectibleModel.query(trx).where('id', collectible.id).patch({
      ownerId: null,
      latestTransferTransactionId: transactions[0].id,
      claimedAt: new Date().toISOString(),
    })

    await EventModel.query(trx).insert([
      ...transactions.map((t) => ({
        action: EventAction.Create,
        entityType: EventEntityType.AlgorandTransaction,
        entityId: t.id,
        userAccountId: userId,
      })),
      {
        action: EventAction.Update,
        entityId: collectible.id,
        entityType: EventEntityType.Collectible,
        userAccountId: userId,
      },
    ])
  }

  async getCollectibles({
    page = 1,
    pageSize = 10,
    locale = DEFAULT_LOCALE,
    sortBy = CollectibleSortField.Title,
    sortDirection = SortDirection.Ascending,
    ownerExternalId,
    ownerUsername,
    templateIds,
    setId,
    collectionId,
  }: CollectibleListQuerystring): Promise<CollectibleListWithTotal | null> {
    const ownerIdentifier = ownerExternalId || ownerUsername
    userInvariant(ownerIdentifier, 'Must specify owner')
    userInvariant(page > 0, 'page must be greater than 0')
    userInvariant(
      pageSize > 0 || pageSize === -1,
      'pageSize must be greater than 0'
    )
    userInvariant(
      [CollectibleSortField.ClaimedAt, CollectibleSortField.Title].includes(
        sortBy
      ),
      'sortBy must be one of claimedAt or title'
    )
    userInvariant(
      [SortDirection.Ascending, SortDirection.Descending].includes(
        sortDirection
      ),
      'sortDirection must be one of asc or desc'
    )

    const field = ownerUsername ? 'username' : 'externalId'
    const account = await UserAccountModel.query()
      .findOne(field, '=', ownerIdentifier)
      .select('id')
    userInvariant(account, 'user not found', 404)

    const total = await CollectibleModel.query()
      .where('ownerId', account.id)
      .count('*', { as: 'count' })
      .first()
      .castTo<{ count: string }>()

    const totalCount = Number.parseInt(total.count, 10)

    if (totalCount === 0) {
      return {
        total: 0,
        collectibles: [],
      }
    }

    const collectibles = await CollectibleModel.query().where({
      ownerId: account.id,
      ...(templateIds
        ? {
            id: {
              _in: templateIds,
            },
          }
        : {}),
    })

    const foundTemplateIds = [...new Set(collectibles.map((c) => c.templateId))]

    const cmsFilter: ItemFilter = {
      id: {
        _in: foundTemplateIds,
      },
    }

    const { collectibles: templates } = await this.cms.findAllCollectibles(
      locale,
      cmsFilter
    )

    const templateLookup = new Map(templates.map((t) => [t.templateId, t]))
    const mappedCollectibles = collectibles
      .map((c) => {
        const template = templateLookup.get(c.templateId)
        invariant(template !== undefined, `template ${c.templateId} not found`)

        return {
          ...template,
          claimedAt:
            c.claimedAt instanceof Date
              ? c.claimedAt.toISOString()
              : c.claimedAt,
          id: c.id,
          address: c.address,
          edition: c.edition,
        } as CollectibleWithDetails
      })
      .filter((collectible) => {
        // need to filter them by set/collection here to avoid invariant error in the .map call above
        if (setId) return collectible.setId === setId
        if (collectionId) return collectible.collectionId === collectionId
        return true
      })
      .sort((a, b) => {
        const direction = sortDirection === SortDirection.Ascending ? 1 : -1
        return direction * (a[sortBy] || '').localeCompare(b[sortBy] || '')
      })

    const collectiblesPage =
      pageSize === -1
        ? mappedCollectibles
        : mappedCollectibles.slice((page - 1) * pageSize, page * pageSize)

    return {
      total: mappedCollectibles.length,
      collectibles: collectiblesPage,
    }
  }

  async getCollectibleTemplates({
    page = 1,
    pageSize = 10,
    locale = DEFAULT_LOCALE,
    sortBy = CollectibleSortField.Title,
    sortDirection = SortDirection.Ascending,
    templateIds = [],
    setId,
    collectionId,
  }: CollectibleListQuerystring): Promise<CollectibleBase[]> {
    userInvariant(page > 0, 'page must be greater than 0')
    userInvariant(
      pageSize > 0 || pageSize === -1,
      'pageSize must be greater than 0'
    )
    userInvariant(
      [CollectibleSortField.ClaimedAt, CollectibleSortField.Title].includes(
        sortBy
      ),
      'sortBy must be one of claimedAt or title'
    )
    userInvariant(
      [SortDirection.Ascending, SortDirection.Descending].includes(
        sortDirection
      ),
      'sortDirection must be one of asc or desc'
    )

    const filter: ItemFilter = {}
    if (templateIds.length > 0) filter.id = { _in: templateIds }
    if (setId) filter.set = { id: { _eq: setId } }
    if (collectionId) filter.collection = { id: { _eq: collectionId } }

    const { collectibles: templates } = await this.cms.findAllCollectibles(
      locale,
      filter
    )

    const collectibles =
      pageSize === -1
        ? templates
        : templates.slice((page - 1) * pageSize, page * pageSize)

    return collectibles
  }

  async getShowcaseCollectibles({
    locale = DEFAULT_LOCALE,
    ownerUsername,
  }: CollectibleShowcaseQuerystring) {
    const user = await UserAccountModel.query()
      .findOne('username', ownerUsername)
      .select('id', 'showProfile')
    userInvariant(user, 'user not found', 404)

    const showcase = await CollectibleShowcaseModel.query()
      .where('ownerId', user.id)
      .orderBy('order', 'asc')
      .withGraphFetched('collectible')

    const collectibles = showcase.map(({ collectible }) => collectible)
    userInvariant(
      isDefinedArray<CollectibleModel>(collectibles),
      'showcase collectibles not found',
      404
    )

    if (collectibles.length === 0) {
      return {
        collectibles: [],
        showProfile: user.showProfile,
      }
    }

    const templateIds = [...new Set(collectibles.map((c) => c.templateId))]

    const { collectibles: templates } = await this.cms.findAllCollectibles(
      locale,
      {
        id: {
          _in: templateIds,
        },
      }
    )

    const templateLookup = new Map(templates.map((t) => [t.templateId, t]))

    const mappedCollectibles = collectibles.map((c): CollectibleWithDetails => {
      const template = templateLookup.get(c.templateId)
      invariant(template !== undefined, `template ${c.templateId} not found`)

      return {
        ...template,
        claimedAt:
          c.claimedAt instanceof Date
            ? c.claimedAt.toISOString()
            : c.claimedAt ?? undefined,
        id: c.id,
        address: c.address ?? undefined,
        edition: c.edition,
      }
    })

    return {
      collectibles: mappedCollectibles,
      showProfile: user.showProfile,
    } as CollectibleListShowcase
  }

  async addShowcaseCollectible(
    {
      ownerUsername,
      collectibleId,
    }: {
      ownerUsername: string
      collectibleId: string
    },
    trx?: Transaction
  ) {
    const user = await UserAccountModel.query(trx)
      .findOne('username', ownerUsername)
      .select('id')

    userInvariant(user, 'user not found', 404)

    const collectible = await CollectibleModel.query(trx).findOne({
      ownerId: user.id,
      id: collectibleId,
    })

    userInvariant(collectible, 'collectible not found', 404)

    const showcases = await CollectibleShowcaseModel.query(trx)
      .where('ownerId', user.id)
      .orderBy('order', 'desc')

    const latestShowcase = showcases[0]

    userInvariant(showcases.length <= MAX_SHOWCASES, 'too many showcases')
    userInvariant(
      !showcases.some((s) => s.collectibleId === collectibleId),
      'collectible already in the showcase'
    )

    const newShowcase = await CollectibleShowcaseModel.query(trx).insert({
      collectibleId: collectible.id,
      ownerId: user.id,
      order: latestShowcase ? latestShowcase.order + 1 : 1,
    })

    await EventModel.query(trx).insert({
      action: EventAction.Create,
      entityType: EventEntityType.CollectibleShowcase,
      entityId: newShowcase.id,
      userAccountId: user.id,
    })
  }

  async removeShowcaseCollectible(
    {
      ownerUsername,
      collectibleId,
    }: {
      ownerUsername: string
      collectibleId: string
    },
    trx?: Transaction
  ) {
    const user = await UserAccountModel.query(trx)
      .findOne('username', ownerUsername)
      .select('id')

    userInvariant(user, 'user not found', 404)

    const showcaseToBeRemoved = await CollectibleShowcaseModel.query(
      trx
    ).findOne({
      ownerId: user.id,
      collectibleId: collectibleId,
    })

    userInvariant(showcaseToBeRemoved, 'collectible not found', 404)

    await CollectibleShowcaseModel.query(trx)
      .where('id', showcaseToBeRemoved.id)
      .delete()

    await EventModel.query(trx).insert({
      action: EventAction.Delete,
      entityType: EventEntityType.CollectibleShowcase,
      entityId: showcaseToBeRemoved.id,
      userAccountId: user.id,
    })

    // normalize the order of the remaining showcases, this way order will
    // always stay in the range of 1..MAX_SHOWCASES (inclusive)
    const showcases = await CollectibleShowcaseModel.query(trx)
      .where('ownerId', user.id)
      .orderBy('order', 'asc')

    await Promise.all(
      showcases.map(async (showcase, index) => {
        await CollectibleShowcaseModel.query(trx)
          .where('id', showcase.id)
          .patch({
            order: index + 1,
          })
        await EventModel.query(trx).insert({
          action: EventAction.Update,
          entityType: EventEntityType.CollectibleShowcase,
          entityId: showcase.id,
          userAccountId: user.id,
        })
      })
    )
  }

  async exportCollectible(request: ExportCollectible, trx?: Transaction) {
    const user = await UserAccountModel.query(trx)
      .findOne({
        externalId: request.externalId,
      })
      .withGraphFetched('algorandAccount')

    userInvariant(user, 'user not found', 404)
    invariant(user.algorandAccount, 'algorand account not loaded')

    const collectible = await CollectibleModel.query(trx)
      .findOne({
        address: request.assetIndex,
      })
      .withGraphFetched('[creationTransaction, pack.payment]')

    userInvariant(collectible, 'collectible not found', 404)
    userInvariant(
      collectible.ownerId == user.id,
      'not the owner of this collectible',
      400
    )
    userInvariant(
      collectible.creationTransaction?.createdAt,
      'collectible not minted',
      400
    )

    const transferrableAt = this.getTransferrableAt(collectible)

    userInvariant(
      isBeforeNow(transferrableAt),
      'collectible cannot yet be transferred',
      400
    )

    const asset = await this.algorand.getAssetInfo(collectible.address)
    userInvariant(!asset.defaultFrozen, 'Frozen assets cannot be exported', 400)

    const result = await this.algorand.generateExportTransactions({
      assetIndex: request.assetIndex,
      encryptedMnemonic: user.algorandAccount.encryptedKey,
      passphrase: request.passphrase,
      fromAccountAddress: user.algorandAccount.address,
      toAccountAddress: request.address,
    })

    await AlgorandTransactionModel.query(trx).insert(
      result.transactionIds.map((txId) => ({
        address: txId,
        status: AlgorandTransactionStatus.Pending,
      }))
    )

    await this.algorand.submitTransaction(result.signedTransactions)

    await CollectibleModel.query(trx)
      .where({
        id: collectible.id,
      })
      .patch({
        ownerId: null,
      })

    return result.transferTxnId
  }
}
