import {
  DEFAULT_LOCALE,
  FirebaseClaim,
  Payment,
  PaymentList,
} from '@algomart/schemas'
import { GetServerSideProps } from 'next'
import { useRouter } from 'next/router'
import useTranslation from 'next-translate/useTranslation'
import { useEffect } from 'react'

import { ApiClient } from '@/clients/api-client'
import Panel from '@/components/panel'
import Table from '@/components/table'
import { ColumnDefinitionType } from '@/components/table'
import { useAuth } from '@/contexts/auth-context'
import DefaultLayout from '@/layouts/default-layout'
import adminService from '@/services/admin-service'
import { isAuthenticatedUserAdmin } from '@/services/api/auth-service'
import { urls } from '@/utils/urls'

export default function AdminTransactionsPage({
  payments,
  total,
}: PaymentList) {
  const auth = useAuth()
  const router = useRouter()
  const { t } = useTranslation()

  useEffect(() => {
    const findUser = async () => {
      try {
        const { claims } = await adminService.getLoggedInUserPermissions()
        // If there is no admin role, throw error
        if (!claims || !claims.includes(FirebaseClaim.admin)) {
          throw new Error('User is not admin')
        }
      } catch (error) {
        console.error(error)
        router.push(urls.home)
      }
    }
    // Check permissions on page render, after auth token is refreshed so claims are fresh
    if (auth.user) {
      findUser()
    }
  }, [auth?.user, router])

  const columns: ColumnDefinitionType<Payment, keyof Payment>[] = [
    { key: 'id', name: 'id' },
    { key: 'packId', name: 'packId' },
    { key: 'status', name: 'status' },
  ]

  return (
    <DefaultLayout
      pageTitle={t('common:pageTitles.Transactions')}
      noPanel
      width="full"
    >
      <Panel title="Transactions" fullWidth>
        <Table<Payment, keyof Payment> columns={columns} data={payments} />
      </Panel>
    </DefaultLayout>
  )
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  // Check if the user is admin (check again on render, to prevent caching of claims)
  const user = await isAuthenticatedUserAdmin(context)
  if (!user) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    }
  }

  const PAYMENTS_PER_PAGE = 10
  const { payments, total } = await ApiClient.instance.getPayments({
    page: 1,
    pageSize: PAYMENTS_PER_PAGE,
    locale: context.locale || DEFAULT_LOCALE,
  })

  return {
    props: { payments, total },
  }
}
