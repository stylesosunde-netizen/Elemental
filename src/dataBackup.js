export const TASKS_KEY = 'elemental-planner-items-v1'
export const LOGBOOK_KEY = 'elemental-logbook-records-v1'
export const BACKUP_FORMAT = 'elemental-data-backup'
export const BACKUP_VERSION = 1

const WITHHOLDING_RATES = [0, 7, 15]
const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024
const TASK_CATEGORIES = new Set([
  'client-work',
  'admin-finance',
  'creative-projects',
  'personal-life',
  'earth',
  'water',
  'fire',
  'air',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('Backup tasks must be a list.')
  const ids = new Set()
  tasks.forEach((task, index) => {
    if (!isObject(task) || typeof task.id !== 'string' || !task.id || typeof task.title !== 'string' ||
      !task.title.trim() || !['task', 'event'].includes(task.type) || typeof task.status !== 'string' ||
      !TASK_CATEGORIES.has(task.category) ||
      !['Low', 'Normal', 'High'].includes(task.priority) ||
      (task.scheduledStart != null && typeof task.scheduledStart !== 'string') ||
      (task.date != null && !isValidDate(task.date)) ||
      (task.time != null && typeof task.time !== 'string') ||
      (task.endDate != null && !isValidDate(task.endDate)) ||
      (task.duration != null && !Number.isFinite(task.duration)) ||
      (task.project != null && typeof task.project !== 'string')) {
      throw new TypeError(`Task ${index + 1} is missing valid app task fields.`)
    }
    if (ids.has(task.id)) throw new TypeError(`Task ID "${task.id}" appears more than once.`)
    ids.add(task.id)
  })
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validateLogbook(records) {
  if (!Array.isArray(records)) throw new TypeError('Backup invoices and expenses must be a list.')
  const ids = new Set()
  records.forEach((record, index) => {
    const validRecord = isObject(record) &&
      typeof record.id === 'string' && record.id &&
      ['income', 'expense'].includes(record.kind) &&
      isValidDate(record.date) &&
      ['number', 'name', 'taxId', 'concept'].every((field) => typeof record[field] === 'string') &&
      Number.isFinite(record.base) && record.base >= 0 &&
      Number.isFinite(record.vatRate) && record.vatRate >= 0 && record.vatRate <= 100 &&
      WITHHOLDING_RATES.includes(record.withholdingRate)
    if (!validRecord) throw new TypeError(`Invoice or expense ${index + 1} is missing valid app record fields.`)
    const optionalAmounts = [
      'baseTotal',
      'vatTotal',
      'irpfRetentionRate',
      'irpfRetentionAmount',
      'totalInvoiceAmount',
      'deductiblePercentage',
      'deductibleBase',
      'deductibleVat',
    ]
    if (optionalAmounts.some((field) => record[field] !== undefined && !Number.isFinite(record[field])) ||
      optionalAmounts.some((field) => record[field] !== undefined && record[field] < 0) ||
      (record.irpfRetentionRate !== undefined && record.irpfRetentionRate > 100) ||
      (record.deductiblePercentage !== undefined && (record.deductiblePercentage < 0 || record.deductiblePercentage > 100)) ||
      (record.ledgerType !== undefined && record.ledgerType !== record.kind) ||
      (record.deductibleBase !== undefined && record.deductibleBase > (record.baseTotal ?? record.base)) ||
      (record.deductibleVat !== undefined && record.deductibleVat > (record.vatTotal ?? record.base * record.vatRate / 100)) ||
      ['ledgerType', 'invoiceNumber', 'supplierName', 'taxIdType', 'paymentAccount', 'category', 'taxRegime']
        .some((field) => record[field] !== undefined && typeof record[field] !== 'string')) {
      throw new TypeError(`Invoice or expense ${index + 1} has invalid tax-compliance fields.`)
    }
    if (ids.has(record.id)) throw new TypeError(`Invoice or expense ID "${record.id}" appears more than once.`)
    ids.add(record.id)
    if (record.attachment !== null && record.attachment !== undefined) {
      const attachment = record.attachment
      if (!isObject(attachment) || typeof attachment.name !== 'string' ||
        !ATTACHMENT_TYPES.includes(attachment.type) || !Number.isFinite(attachment.size) ||
        attachment.size < 0 || attachment.size > MAX_ATTACHMENT_SIZE ||
        typeof attachment.data !== 'string' || !attachment.data.startsWith(`data:${attachment.type};base64,`)) {
        throw new TypeError(`Attachment on invoice or expense ${index + 1} is invalid.`)
      }
    }
  })
}

export function createBackup(tasks, logbook, exportedAt = new Date().toISOString()) {
  validateTasks(tasks)
  validateLogbook(logbook)
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    tasks,
    logbook,
  }
}

export function parseBackup(json) {
  let backup
  try {
    backup = JSON.parse(json)
  } catch {
    throw new TypeError('That file is not valid JSON.')
  }
  if (!isObject(backup) || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new TypeError('This is not a supported Elemental backup file.')
  }
  validateTasks(backup.tasks)
  validateLogbook(backup.logbook)
  return { tasks: backup.tasks, logbook: backup.logbook }
}
