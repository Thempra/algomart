export function isAfterNow(date: Date) {
  const now = new Date()
  return date > now
}

export function isBeforeNow(date: Date) {
  return date < new Date()
}

export function isNowBetweenDates(dateStart: Date, dateEnd: Date) {
  const now = new Date()
  return dateStart < now && now < dateEnd
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}
