import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKUP_FORMAT, BACKUP_VERSION, createBackup, parseBackup } from '../src/dataBackup.js'

const task = {
  id: 'task-1',
  title: 'Prepare invoice',
  type: 'task',
  category: 'earth',
  priority: 'Normal',
  status: 'ready',
  duration: 30,
  date: null,
  time: null,
}

const invoice = {
  id: 'invoice-1',
  kind: 'income',
  date: '2026-10-11',
  number: 'INV-001',
  name: 'Client',
  taxId: 'X123',
  concept: 'Design work',
  base: 100,
  vatRate: 21,
  withholdingRate: 0,
  attachment: {
    name: 'invoice.pdf',
    type: 'application/pdf',
    size: 3,
    data: 'data:application/pdf;base64,JVBERg==',
  },
}

test('backup round-trips tasks, invoices, and attached files', () => {
  const backup = createBackup([task], [invoice], '2026-10-11T10:00:00.000Z')
  assert.equal(backup.format, BACKUP_FORMAT)
  assert.equal(backup.version, BACKUP_VERSION)
  assert.deepEqual(parseBackup(JSON.stringify(backup)), { tasks: [task], logbook: [invoice] })
})

test('backup rejects unsupported files and invalid task records', () => {
  assert.throws(() => parseBackup('not json'), /not valid JSON/)
  assert.throws(() => parseBackup(JSON.stringify({ format: 'other', version: 1 })), /not a supported/)
  assert.throws(() => createBackup([{ ...task, category: 'invalid' }], []), /Task 1/)
})

test('task backups accept practical categories and retain legacy category support', () => {
  const practicalTask = { ...task, category: 'creative-projects' }
  assert.deepEqual(parseBackup(JSON.stringify(createBackup([practicalTask], []))).tasks, [practicalTask])
  assert.deepEqual(parseBackup(JSON.stringify(createBackup([task], []))).tasks, [task])
})

test('backup rejects invalid invoice fields and attachments', () => {
  assert.throws(() => createBackup([], [{ ...invoice, date: '2026-02-30' }]), /record fields/)
  assert.throws(() => createBackup([], [{ ...invoice, attachment: { ...invoice.attachment, size: 3 * 1024 * 1024 } }]), /Attachment/)
})

test('backup supports custom VAT rates and validates compliance amounts', () => {
  const compliantExpense = {
    ...invoice,
    id: 'expense-1',
    kind: 'expense',
    base: 100,
    baseTotal: 100,
    vatRate: 12.5,
    vatTotal: 12.5,
    deductiblePercentage: 50,
    deductibleBase: 50,
    deductibleVat: 6.25,
    ledgerType: 'expense',
    invoiceNumber: 'EXP-1',
    supplierName: 'Supplier',
    taxIdType: 'nif-cif',
    paymentAccount: 'BBVA',
    category: 'equipment',
    taxRegime: 'national',
  }
  assert.deepEqual(parseBackup(JSON.stringify(createBackup([], [compliantExpense]))).logbook, [compliantExpense])
  assert.throws(() => createBackup([], [{ ...compliantExpense, deductibleVat: 13 }]), /tax-compliance fields/)
})
