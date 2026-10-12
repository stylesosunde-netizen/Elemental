export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

export function parseDecimalInput(value) {
  return Number.parseFloat(String(value).replace(',', '.'))
}

export function getLatestSuppliers(records) {
  const latestByName = new Map()
  records
    .filter((record) => record.kind === 'expense')
    .forEach((record) => {
      const name = String(record.supplierName ?? record.name ?? '').trim()
      if (!name) return

      const key = name.toLocaleLowerCase()
      const latest = latestByName.get(key)
      if (!latest || record.date >= latest.date) latestByName.set(key, record)
    })
  return [...latestByName.values()].sort((left, right) =>
    String(left.supplierName ?? left.name).localeCompare(String(right.supplierName ?? right.name)),
  )
}

function baseAmount(record) {
  return Number(record.baseTotal ?? record.base ?? 0)
}

export function getTax(record, rateField) {
  if (rateField === 'vatRate' && Number.isFinite(Number(record.vatTotal))) {
    return Number(record.vatTotal)
  }
  if (rateField === 'withholdingRate' && Number.isFinite(Number(record.irpfRetentionAmount))) {
    return Number(record.irpfRetentionAmount)
  }
  return roundMoney((baseAmount(record) * Number(record[rateField])) / 100)
}

export function getDeductibleBase(record) {
  if (Number.isFinite(Number(record.deductibleBase))) return Number(record.deductibleBase)
  return roundMoney(baseAmount(record) * Number(record.deductiblePercentage ?? 100) / 100)
}

export function getDeductibleVat(record) {
  if (Number.isFinite(Number(record.deductibleVat))) return Number(record.deductibleVat)
  return roundMoney(getTax(record, 'vatRate') * Number(record.deductiblePercentage ?? 100) / 100)
}

export function getTotal(record) {
  if (Number.isFinite(Number(record.totalInvoiceAmount))) return Number(record.totalInvoiceAmount)
  return roundMoney(baseAmount(record) + getTax(record, 'vatRate') - getTax(record, 'withholdingRate'))
}

export function normalizeRecord(record) {
  const kind = record.ledgerType ?? record.kind
  const base = baseAmount(record)
  const vatRate = Number(record.vatRate ?? 0)
  const withholdingRate = Number(record.irpfRetentionRate ?? record.withholdingRate ?? 0)
  const vatTotal = Number.isFinite(Number(record.vatTotal))
    ? Number(record.vatTotal)
    : roundMoney(base * vatRate / 100)
  const irpfRetentionAmount = Number.isFinite(Number(record.irpfRetentionAmount))
    ? Number(record.irpfRetentionAmount)
    : roundMoney(base * withholdingRate / 100)
  const deductiblePercentage = Number.isFinite(Number(record.deductiblePercentage))
    ? Number(record.deductiblePercentage)
    : 100
  const deductibleBase = Number.isFinite(Number(record.deductibleBase))
    ? Number(record.deductibleBase)
    : roundMoney(base * deductiblePercentage / 100)
  const deductibleVat = Number.isFinite(Number(record.deductibleVat))
    ? Number(record.deductibleVat)
    : roundMoney(vatTotal * deductiblePercentage / 100)
  const totalInvoiceAmount = Number.isFinite(Number(record.totalInvoiceAmount))
    ? Number(record.totalInvoiceAmount)
    : roundMoney(base + vatTotal - irpfRetentionAmount)
  const invoiceNumber = record.invoiceNumber ?? record.number ?? ''
  const supplierName = record.supplierName ?? record.name ?? ''
  const taxId = record.taxId ?? ''
  const concept = record.concept ?? ''

  return {
    ...record,
    kind,
    ledgerType: kind,
    number: invoiceNumber,
    invoiceNumber,
    name: supplierName,
    supplierName,
    taxId,
    concept,
    base,
    baseTotal: base,
    vatRate,
    vatTotal,
    withholdingRate,
    irpfRetentionRate: withholdingRate,
    irpfRetentionAmount,
    totalInvoiceAmount,
    deductiblePercentage,
    deductibleBase,
    deductibleVat,
    taxIdType: record.taxIdType ?? '',
    paymentAccount: record.paymentAccount ?? '',
    category: record.category ?? '',
    taxRegime: record.taxRegime ?? 'national',
  }
}

export function getQuarter(date) {
  return Math.floor(new Date(`${date}T12:00:00`).getMonth() / 3) + 1
}

export function filterRecordsByPeriod(records, year, quarter) {
  return records.filter((record) => record.date.slice(0, 4) === year &&
    (quarter === 'all' || String(getQuarter(record.date)) === quarter))
}

export function getLedgerMetrics(incomes, expenses) {
  return {
    income: roundMoney(incomes.reduce((total, record) => total + getTotal(record), 0)),
    vatCollected: roundMoney(incomes.reduce((total, record) => total + getTax(record, 'vatRate'), 0)),
    expenses: roundMoney(expenses.reduce((total, record) => total + getTotal(record), 0)),
    vatPaid: roundMoney(expenses.reduce((total, record) => total + getDeductibleVat(record), 0)),
    netProfit: roundMoney(
      incomes.reduce((total, record) => total + baseAmount(record), 0) -
      expenses.reduce((total, record) => total + getDeductibleBase(record), 0),
    ),
  }
}
