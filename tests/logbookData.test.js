import assert from 'node:assert/strict'
import test from 'node:test'
import { filterRecordsByPeriod, getDeductibleBase, getDeductibleVat, getLatestSuppliers, getLedgerMetrics, getTax, getTotal, normalizeRecord, parseDecimalInput } from '../src/logbookData.js'

const records = [
  { kind: 'income', date: '2026-01-12', base: 100, vatRate: 21, withholdingRate: 7 },
  { kind: 'expense', date: '2026-02-10', base: 20, vatRate: 21, withholdingRate: 0 },
  { kind: 'income', date: '2026-10-11', base: 200, vatRate: 21, withholdingRate: 0 },
  { kind: 'expense', date: '2025-10-11', base: 50, vatRate: 21, withholdingRate: 0 },
]

test('fiscal period filtering supports individual quarters and the full year', () => {
  assert.deepEqual(filterRecordsByPeriod(records, '2026', '1'), records.slice(0, 2))
  assert.deepEqual(filterRecordsByPeriod(records, '2026', '4'), [records[2]])
  assert.deepEqual(filterRecordsByPeriod(records, '2026', 'all'), records.slice(0, 3))
})

test('decimal input parsing accepts comma and period separators', () => {
  assert.equal(parseDecimalInput('25.02'), 25.02)
  assert.equal(parseDecimalInput('25,02'), 25.02)
})

test('supplier suggestions return the latest expense for each case-insensitive name', () => {
  const suppliers = getLatestSuppliers([
    { kind: 'expense', date: '2026-01-01', name: 'Digi', taxId: 'OLD' },
    { kind: 'expense', date: '2026-02-01', name: 'DIGI', taxId: 'NEW' },
    { kind: 'income', date: '2026-03-01', name: 'Amazon', taxId: 'CLIENT' },
    { kind: 'expense', date: '2026-01-15', name: 'Amazon', taxId: 'SUPPLIER' },
  ])
  assert.equal(suppliers.length, 2)
  assert.equal(suppliers.find((supplier) => supplier.taxId === 'NEW').name, 'DIGI')
  assert.equal(suppliers.find((supplier) => supplier.taxId === 'SUPPLIER').name, 'Amazon')
})

test('ledger net profit subtracts expense base from income base without VAT', () => {
  const summary = getLedgerMetrics(
    records.filter((record) => record.kind === 'income').slice(0, 1),
    records.filter((record) => record.kind === 'expense').slice(0, 1),
  )
  assert.equal(summary.netProfit, 80)
  assert.equal(summary.income, 114)
  assert.equal(summary.vatCollected, 21)
  assert.equal(summary.expenses, 24.2)
  assert.equal(summary.vatPaid, 4.2)
})

test('legacy ledger records normalize without losing their original fields', () => {
  const legacy = { ...records[1], number: 'OLD-001', name: 'Existing supplier' }
  const normalized = normalizeRecord(legacy)
  assert.equal(normalized.number, legacy.number)
  assert.equal(normalized.name, legacy.name)
  assert.equal(normalized.kind, 'expense')
  assert.equal(normalized.baseTotal, 20)
  assert.equal(normalized.vatTotal, 4.2)
  assert.equal(normalized.deductiblePercentage, 100)
  assert.equal(normalized.deductibleVat, 4.2)
})

test('partial deductibility preserves statutory invoice totals and claims only eligible amounts', () => {
  const expense = normalizeRecord({
    kind: 'expense',
    date: '2026-02-10',
    number: 'MIXED-001',
    name: 'Supplier',
    taxId: 'X123',
    concept: 'Mixed-use purchase',
    base: 100,
    vatRate: 21,
    vatTotal: 21,
    withholdingRate: 0,
    deductiblePercentage: 50,
    deductibleBase: 50,
    deductibleVat: 10.5,
    totalInvoiceAmount: 121,
  })
  const summary = getLedgerMetrics([], [expense])
  assert.equal(getTax(expense, 'vatRate'), 21)
  assert.equal(getTotal(expense), 121)
  assert.equal(getDeductibleBase(expense), 50)
  assert.equal(getDeductibleVat(expense), 10.5)
  assert.equal(summary.vatPaid, 10.5)
  assert.equal(summary.netProfit, -50)
})
