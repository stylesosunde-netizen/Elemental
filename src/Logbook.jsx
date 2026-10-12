import { useMemo, useState } from 'react'
import { Download, FileText, Image, Paperclip, Plus, ReceiptText, Trash2, X } from 'lucide-react'
import { LOGBOOK_KEY } from './dataBackup'
import { filterRecordsByPeriod, getDeductibleBase, getDeductibleVat, getLatestSuppliers, getLedgerMetrics, getQuarter, getTax, getTotal, normalizeRecord, parseDecimalInput, roundMoney } from './logbookData'
import './Logbook.css'

const VAT_RATES = [0, 4, 10, 21]
const WITHHOLDING_RATES = [0, 7, 15]
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024
const VAT_EXEMPT_CATEGORIES = ['cuota-autonomos', 'bank-fees']
const CATEGORY_LABELS = {
  equipment: 'Equipment & Hardware',
  software: 'Software & Cloud Services',
  'professional-fees': 'Professional Fees / Gestoría',
  'office-supplies': 'Office Supplies',
  telecom: 'Telecom & Internet',
  'cuota-autonomos': 'Cuota Autónomos (TGSS Social Security)',
  'bank-fees': 'Bank Account Fees',
  'municipal-taxes': 'Municipal Taxes',
  'capital-assets': 'Bienes de inversión (Capítulo 3)',
}
const TAX_REGIMES = [
  { value: 'national', label: 'National Standard (General 21%, Reducido 10%, Superreducido 4%)' },
  { value: 'intra-community', label: 'Intra-Community EU / Reverse Charge (0% VAT)' },
  { value: 'extra-community', label: 'Extra-Community / Non-EU Import of Services (e.g., US SaaS like Lovable, OpenAI - 0% Spanish VAT)' },
  { value: 'exempt', label: 'Exempt / 0% VAT (e.g., Social Security, Financial operations)' },
]
const TAX_ID_TYPE_LABELS = {
  'nif-cif': 'NIF/CIF (Spain)',
  vies: 'VIES / Intra-Community VAT',
  foreign: 'Foreign / Passport / US EIN',
}
const CSV_COLUMNS = [
  'Fecha de expedición',
  'Número de factura',
  'Nombre / Razón social',
  'NIF / CIF',
  'Tipo de identificación fiscal',
  'Cuenta de pago',
  'Categoría',
  'Régimen fiscal',
  'Concepto',
  'Base imponible',
  'Tipo IVA (%)',
  'Cuota IVA',
  'Retención IRPF (%)',
  'Cuota IRPF',
  'Importe total',
  'Porcentaje deducible (%)',
  'Base deducible IRPF',
  'IVA deducible Modelo 303',
  'Archivo adjunto',
]

function currentDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function readRecords() {
  try {
    const stored = localStorage.getItem(LOGBOOK_KEY)
    const records = stored ? JSON.parse(stored) : []
    if (!Array.isArray(records)) throw new TypeError('Ledger data is not a list.')
    return { records: records.map(normalizeRecord), error: '' }
  } catch {
    return { records: [], error: 'Could not read the saved ledger. Existing entries may be unavailable; saving a new record will replace the unread data.' }
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value || 0)
}

function formatCsvNumber(value) {
  return Number(value || 0).toFixed(2).replace('.', ',')
}

function csvCell(value) {
  const source = String(value ?? '')
  const text = /^[\t\r=+\-@]/.test(source) ? `'${source}` : source
  return `"${text.replaceAll('"', '""')}"`
}

function csvDate(value) {
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}

function makeCsvSection(label, records) {
  const lines = [csvCell(label), CSV_COLUMNS.map(csvCell).join(';')]
  records.forEach((record) => {
    lines.push([
      csvDate(record.date),
      record.number,
      record.name,
      record.taxId,
      TAX_ID_TYPE_LABELS[record.taxIdType] || record.taxIdType,
      record.paymentAccount,
      CATEGORY_LABELS[record.category] || record.category,
      TAX_REGIMES.find((regime) => regime.value === record.taxRegime)?.label || record.taxRegime,
      record.concept,
      formatCsvNumber(record.baseTotal),
      record.vatRate,
      formatCsvNumber(getTax(record, 'vatRate')),
      record.irpfRetentionRate,
      formatCsvNumber(getTax(record, 'withholdingRate')),
      formatCsvNumber(getTotal(record)),
      record.deductiblePercentage,
      formatCsvNumber(getDeductibleBase(record)),
      formatCsvNumber(getDeductibleVat(record)),
      record.attachment?.name || '',
    ].map(csvCell).join(';'))
  })
  return lines.join('\r\n')
}

function downloadCsv(records, quarter, year) {
  const selectedQuarters = quarter === 'all' ? [1, 2, 3, 4] : [Number(quarter)]
  const content = selectedQuarters.flatMap((quarterNumber) => {
    const quarterRecords = records.filter((record) =>
      String(getQuarter(record.date)) === String(quarterNumber),
    )
    return [
      makeCsvSection(`Q${quarterNumber} · INGRESOS`, quarterRecords.filter((record) => record.kind === 'income')),
      '',
      makeCsvSection(`Q${quarterNumber} · GASTOS`, quarterRecords.filter((record) => record.kind === 'expense')),
      '',
    ]
  }).join('\r\n')
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `logbook-${quarter === 'all' ? 'full-year' : `q${quarter}`}-${year}.csv`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function emptyDraft(kind) {
  return {
    kind,
    ledgerType: kind,
    date: currentDate(),
    number: '',
    invoiceNumber: '',
    name: '',
    supplierName: '',
    taxId: '',
    taxIdType: 'nif-cif',
    paymentAccount: '',
    category: '',
    taxRegime: 'national',
    concept: '',
    base: '',
    baseTotal: '',
    vatRate: '21',
    vatRateMode: 'preset',
    vatTotal: '',
    vatTotalOverridden: false,
    withholdingRate: '0',
    irpfRetentionRate: '0',
    irpfRetentionAmount: '0',
    totalInvoiceAmount: '0',
    deductiblePercentage: '100',
    deductibleBase: '',
    deductibleBaseOverridden: false,
    deductibleVat: '',
    deductibleVatOverridden: false,
    attachment: null,
  }
}

function LogbookForm({ record, initialKind, clients, suppliers, onClose, onSave }) {
  const [draft, setDraft] = useState(() => record ? normalizeRecord(record) : emptyDraft(initialKind))
  const [selectedClient, setSelectedClient] = useState('')
  const [attachmentError, setAttachmentError] = useState('')
  const isEditing = Boolean(record)
  const vatLocked = draft.taxRegime !== 'national' || VAT_EXEMPT_CATEGORIES.includes(draft.category)
  const deductibleLocked = draft.kind === 'expense' && VAT_EXEMPT_CATEGORIES.includes(draft.category)
  const effectiveVatRate = Number(draft.vatRate) || 0
  const baseTotal = Number(draft.baseTotal) || 0
  const vatTotal = Number(draft.vatTotal) || 0
  const irpfRetentionAmount = roundMoney(baseTotal * (Number(draft.irpfRetentionRate) || 0) / 100)
  const deductibleBase = Number(draft.deductibleBase) || 0
  const deductibleVat = Number(draft.deductibleVat) || 0
  const totalInvoiceAmount = roundMoney(baseTotal + vatTotal - irpfRetentionAmount)

  function refreshCalculatedAmounts(next) {
    const base = Number(next.baseTotal) || 0
    const parsedPercent = parseDecimalInput(next.deductiblePercentage)
    const percentage = Number.isFinite(parsedPercent) ? parsedPercent : 0
    if (!next.vatTotalOverridden) next.vatTotal = roundMoney(base * (Number(next.vatRate) || 0) / 100)
    if (!next.deductibleBaseOverridden) next.deductibleBase = roundMoney(base * percentage / 100)
    if (!next.deductibleVatOverridden) next.deductibleVat = roundMoney((Number(next.vatTotal) || 0) * percentage / 100)
    next.irpfRetentionAmount = roundMoney(base * (Number(next.irpfRetentionRate) || 0) / 100)
    next.totalInvoiceAmount = roundMoney(base + (Number(next.vatTotal) || 0) - next.irpfRetentionAmount)
    return next
  }

  function setField(name, value) {
    setDraft((previous) => {
      const next = { ...previous, [name]: value }
      if (name === 'kind' || name === 'ledgerType') {
        next.kind = value
        next.ledgerType = value
      }
      if (name === 'number' || name === 'invoiceNumber') {
        next.number = value
        next.invoiceNumber = value
      }
      if (name === 'name' || name === 'supplierName') {
        next.name = value
        next.supplierName = value
      }
      if (name === 'base' || name === 'baseTotal') {
        next.base = value
        next.baseTotal = value
      }
      if (name === 'withholdingRate' || name === 'irpfRetentionRate') {
        next.withholdingRate = value
        next.irpfRetentionRate = value
      }
      return refreshCalculatedAmounts(next)
    })
  }

  function updateField(event) {
    const { name, value } = event.target
    if (name === 'supplierName' && draft.kind === 'expense') {
      const supplier = suppliers.find((entry) =>
        String(entry.supplierName ?? entry.name).trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase(),
      )
      if (supplier) {
        setDraft((previous) => refreshCalculatedAmounts({
          ...previous,
          name: supplier.name,
          supplierName: supplier.supplierName,
          taxId: supplier.taxId,
          taxIdType: supplier.taxIdType,
          paymentAccount: supplier.paymentAccount,
          category: supplier.category,
          taxRegime: supplier.taxRegime,
          vatRate: String(supplier.vatRate),
          vatRateMode: supplier.vatRateMode || (VAT_RATES.includes(Number(supplier.vatRate)) ? 'preset' : 'custom'),
          withholdingRate: String(supplier.irpfRetentionRate),
          irpfRetentionRate: String(supplier.irpfRetentionRate),
          deductiblePercentage: String(supplier.deductiblePercentage),
          date: currentDate(),
          number: '',
          invoiceNumber: '',
          concept: supplier.concept,
          base: '',
          baseTotal: '',
          vatTotal: '',
          vatTotalOverridden: false,
          irpfRetentionAmount: '0',
          totalInvoiceAmount: '0',
          deductibleBase: '',
          deductibleBaseOverridden: false,
          deductibleVat: '',
          deductibleVatOverridden: false,
          attachment: null,
        }))
        setAttachmentError('')
        return
      }
    }
    if (name === 'vatRateMode') {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        vatRateMode: value,
        vatRate: value === 'preset' ? (VAT_RATES.includes(Number(previous.vatRate)) ? previous.vatRate : '21') : previous.vatRate,
      }))
      return
    }
    if (name === 'category' && VAT_EXEMPT_CATEGORIES.includes(value)) {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        category: value,
        vatRate: '0',
        vatRateMode: 'preset',
        vatTotal: '0',
        vatTotalOverridden: false,
        deductiblePercentage: '100',
        deductibleBaseOverridden: false,
        deductibleVatOverridden: false,
      }))
      return
    }
    if (name === 'taxRegime' && value !== 'national') {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        taxRegime: value,
        vatRate: '0',
        vatRateMode: 'preset',
        vatTotal: '0',
        vatTotalOverridden: false,
      }))
      return
    }
    if (name === 'vatRate' && value !== 'custom') {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        vatRate: value,
        vatRateMode: 'preset',
        vatTotalOverridden: false,
      }))
      return
    }
    if (name === 'vatRate' && value === 'custom') {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        vatRateMode: 'custom',
        vatTotalOverridden: false,
      }))
      return
    }
    if (name === 'vatTotal') {
      setDraft((previous) => refreshCalculatedAmounts({ ...previous, vatTotal: value, vatTotalOverridden: true, deductibleVatOverridden: false }))
      return
    }
    if (name === 'customVatRate') {
      setDraft((previous) => refreshCalculatedAmounts({
        ...previous,
        vatRate: value,
        vatRateMode: 'custom',
        vatTotalOverridden: false,
      }))
      return
    }
    if (name === 'deductibleBase') {
      setDraft((previous) => refreshCalculatedAmounts({ ...previous, deductibleBase: value, deductibleBaseOverridden: true }))
      return
    }
    if (name === 'deductibleVat') {
      setDraft((previous) => refreshCalculatedAmounts({ ...previous, deductibleVat: value, deductibleVatOverridden: true }))
      return
    }
    if (name === 'deductiblePercentage' && deductibleLocked) return
    setField(name, value)
  }

  function updateLedgerType(event) {
    const kind = event.target.value
    setDraft((previous) => refreshCalculatedAmounts({
      ...previous,
      kind,
      ledgerType: kind,
      category: kind === 'income' ? '' : previous.category,
      deductiblePercentage: kind === 'income' ? '100' : previous.deductiblePercentage,
      deductibleBaseOverridden: kind === 'income' ? false : previous.deductibleBaseOverridden,
      deductibleVatOverridden: kind === 'income' ? false : previous.deductibleVatOverridden,
    }))
  }

  function toggleManualOverride(field, event) {
    const checked = event.target.checked
    setDraft((previous) => {
      const next = { ...previous, [field]: checked }
      return refreshCalculatedAmounts(next)
    })
  }

  function loadClient(event) {
    const client = clients.find((entry) => entry.key === event.target.value)
    setSelectedClient(event.target.value)
    if (!client) return
    setDraft((previous) => ({
      ...previous,
      name: client.name,
      supplierName: client.name,
      taxId: client.taxId,
      concept: client.concept,
      base: String(client.base),
      baseTotal: String(client.baseTotal),
      vatRate: String(client.vatRate),
      vatTotal: String(client.vatTotal),
      vatTotalOverridden: Boolean(client.vatTotalOverridden),
      withholdingRate: String(client.withholdingRate),
      irpfRetentionRate: String(client.irpfRetentionRate),
    }))
  }

  function acceptAttachment(file) {
    if (!file) return
    const validType = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)
    if (!validType) {
      setAttachmentError('Use a PDF, JPEG, or PNG file.')
      return
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setAttachmentError('File must be 2 MB or smaller.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setAttachmentError('The selected file could not be read.')
        return
      }
      setDraft((previous) => ({
        ...previous,
        attachment: { name: file.name, type: file.type, size: file.size, data: reader.result },
      }))
      setAttachmentError('')
    }
    reader.onerror = () => setAttachmentError('The selected file could not be read.')
    reader.readAsDataURL(file)
  }

  function uploadAttachment(event) {
    acceptAttachment(event.target.files?.[0])
    event.target.value = ''
  }

  function dropAttachment(event) {
    event.preventDefault()
    acceptAttachment(event.dataTransfer.files?.[0])
  }

  function submit(event) {
    event.preventDefault()
    if (!draft.attachment) {
      setAttachmentError('Attach the invoice or receipt before saving.')
      return
    }
    const saved = normalizeRecord({
      ...draft,
      kind: draft.kind,
      ledgerType: draft.kind,
      number: draft.invoiceNumber,
      invoiceNumber: draft.invoiceNumber,
      name: draft.supplierName,
      supplierName: draft.supplierName,
      base: Number(draft.baseTotal),
      baseTotal: Number(draft.baseTotal),
      vatRate: effectiveVatRate,
      vatTotal: roundMoney(vatTotal),
      withholdingRate: Number(draft.irpfRetentionRate),
      irpfRetentionRate: Number(draft.irpfRetentionRate),
      irpfRetentionAmount,
      totalInvoiceAmount,
      deductiblePercentage: Number.isFinite(parseDecimalInput(draft.deductiblePercentage))
        ? parseDecimalInput(draft.deductiblePercentage)
        : 0,
      deductibleBase: roundMoney(deductibleBase),
      deductibleVat: roundMoney(deductibleVat),
    })
    onSave(saved)
  }

  return (
    <div className="logbook-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="logbook-form" role="dialog" aria-modal="true" aria-labelledby="logbook-form-title">
        <header className="logbook-form-heading">
          <div><span className="logbook-kicker">RECORD ENTRY</span><h2 id="logbook-form-title">{isEditing ? 'Edit record' : 'New record'}</h2></div>
          <button className="logbook-icon-button" type="button" aria-label="Close form" onClick={onClose}><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          <fieldset className="logbook-kind-switch"><legend>LEDGER TYPE</legend>
            <label><input type="radio" name="kind" value="income" checked={draft.kind === 'income'} onChange={updateLedgerType} /> INCOME / EMITIDA</label>
            <label><input type="radio" name="kind" value="expense" checked={draft.kind === 'expense'} onChange={updateLedgerType} /> EXPENSE / RECIBIDA</label>
          </fieldset>
          <section className="logbook-form-section">
            <h3>DOCUMENT &amp; IDENTIFICATION</h3>
            <div className="logbook-form-grid">
              <label>DATE OF ISSUE<input type="date" name="date" value={draft.date} onChange={updateField} required /></label>
              <label>INVOICE NUMBER<input name="invoiceNumber" value={draft.invoiceNumber} onChange={updateField} placeholder="INV-2026-001" required /></label>
              {draft.kind === 'income' && clients.length > 0 && <label className="logbook-wide">LOAD SAVED CLIENT
                <select value={selectedClient} onChange={loadClient}>
                  <option value="">Choose a client from previous invoices</option>
                  {clients.map((client) => <option key={client.key} value={client.key}>{client.name} · {client.taxId}</option>)}
                </select>
              </label>}
              <label>{draft.kind === 'income' ? 'CLIENT / LEGAL NAME' : 'SUPPLIER / LEGAL NAME'}<input name="supplierName" value={draft.supplierName} onChange={updateField} list={draft.kind === 'expense' ? 'logbook-suppliers' : undefined} required />
                {draft.kind === 'expense' && <datalist id="logbook-suppliers">{suppliers.map((supplier) => <option key={supplier.id || supplier.supplierName || supplier.name} value={supplier.supplierName || supplier.name} />)}</datalist>}
              </label>
              <label>NIF / CIF / NIE / VAT ID<input name="taxId" value={draft.taxId} onChange={updateField} required /></label>
              <label>TAX ID TYPE<select name="taxIdType" value={draft.taxIdType} onChange={updateField}>
                <option value="">Select type</option>
                <option value="nif-cif">NIF/CIF (Spain)</option>
                <option value="vies">VIES / Intra-Community VAT</option>
                <option value="foreign">Foreign / Passport / US EIN</option>
              </select></label>
              <label>PAYMENT ACCOUNT<select name="paymentAccount" value={draft.paymentAccount} onChange={updateField}>
                <option value="">Select source</option>
                {['BBVA', 'Revolut', 'Bizum', 'Cash', 'Other'].map((account) => <option key={account} value={account}>{account}</option>)}
              </select></label>
              {draft.kind === 'expense' && <label className="logbook-wide">STATUTORY CATEGORY
                <select name="category" value={draft.category} onChange={updateField} required={!isEditing}>
                  <option value="">Select category</option>
                  <optgroup label="Gastos con factura (Capítulo 2.1)">
                    <option value="equipment">Equipment &amp; Hardware</option>
                    <option value="software">Software &amp; Cloud Services</option>
                    <option value="professional-fees">Professional Fees / Gestoría</option>
                    <option value="office-supplies">Office Supplies</option>
                    <option value="telecom">Telecom &amp; Internet</option>
                  </optgroup>
                  <optgroup label="Gastos sin factura (Capítulo 2.2)">
                    <option value="cuota-autonomos">Cuota Autónomos (TGSS Social Security)</option>
                    <option value="bank-fees">Bank Account Fees</option>
                    <option value="municipal-taxes">Municipal Taxes</option>
                  </optgroup>
                  <optgroup label="Bienes de inversión (Capítulo 3)">
                    <option value="capital-assets">Capital assets &gt; 3,005.06 € (multi-year amortization)</option>
                  </optgroup>
                </select>
              </label>}
              <label className="logbook-wide">CONCEPT / DESCRIPTION<input name="concept" value={draft.concept} onChange={updateField} required /></label>
            </div>
          </section>
          <section className="logbook-form-section">
            <h3>TAX REGIME &amp; INVOICING</h3>
            <div className="logbook-form-grid">
              <label className="logbook-wide">TAX REGIME<select name="taxRegime" value={draft.taxRegime} onChange={updateField}>
                {TAX_REGIMES.map((regime) => <option key={regime.value} value={regime.value}>{regime.label}</option>)}
              </select></label>
              <label>GROSS TAX BASE (€)<input type="number" name="baseTotal" min="0" step="0.01" value={draft.baseTotal} onChange={updateField} required /></label>
              <label>VAT RATE (%)
                <select name="vatRate" value={draft.vatRateMode === 'custom' ? 'custom' : String(effectiveVatRate)} onChange={updateField} disabled={vatLocked}>
                  {VAT_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                  <option value="custom">Custom</option>
                </select>
              </label>
              {draft.vatRateMode === 'custom' && <label>CUSTOM VAT RATE (%)<input type="number" name="customVatRate" min="0" max="100" step="0.01" value={draft.vatRate} onChange={updateField} disabled={vatLocked} required /></label>}
              <label>VAT TOTAL (€)<input type="number" name="vatTotal" min="0" step="0.01" value={draft.vatTotal} onChange={updateField} disabled={vatLocked} />
                <span className="logbook-manual-override"><input type="checkbox" checked={Boolean(draft.vatTotalOverridden)} onChange={(event) => toggleManualOverride('vatTotalOverridden', event)} disabled={vatLocked} /> Manual rounding override</span>
              </label>
              <label>IRPF RETENTION RATE (%)<select name="irpfRetentionRate" value={draft.irpfRetentionRate} onChange={updateField}>
                {WITHHOLDING_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
              </select></label>
              <div className="logbook-total-preview"><span>IRPF RETENTION</span><strong>{formatMoney(irpfRetentionAmount)}</strong></div>
              <div className="logbook-total-preview logbook-invoice-total"><span>TOTAL INVOICE AMOUNT</span><strong>{formatMoney(totalInvoiceAmount)}</strong></div>
              {draft.kind === 'expense' && <div className="logbook-deductibility logbook-wide">
                <div className="logbook-deductibility-heading"><h3>DEDUCTIBILITY BREAKDOWN</h3><span>CLAIMABLE AMOUNTS</span></div>
                <div className="logbook-form-grid">
                  <label>DEDUCTIBLE PERCENTAGE (%)<input type="number" name="deductiblePercentage" step="any" min="0" max="100" value={deductibleLocked ? '100' : draft.deductiblePercentage} onChange={updateField} disabled={deductibleLocked} /></label>
                  <label>DEDUCTIBLE BASE · IRPF (€)<input type="number" name="deductibleBase" min="0" max={baseTotal} step="0.01" value={draft.deductibleBase} onChange={updateField} />
                    <span className="logbook-manual-override"><input type="checkbox" checked={Boolean(draft.deductibleBaseOverridden)} onChange={(event) => toggleManualOverride('deductibleBaseOverridden', event)} /> Manual override</span>
                  </label>
                  <label className="logbook-wide">DEDUCTIBLE VAT · MODELO 303 (€)<input type="number" name="deductibleVat" min="0" max={vatTotal} step="0.01" value={draft.deductibleVat} onChange={updateField} />
                    <span className="logbook-manual-override"><input type="checkbox" checked={Boolean(draft.deductibleVatOverridden)} onChange={(event) => toggleManualOverride('deductibleVatOverridden', event)} /> Manual override</span>
                  </label>
                </div>
                {parseDecimalInput(draft.deductiblePercentage) < 100 && <p className="logbook-audit-alert" role="status">Showing partial deduction: Only {formatMoney(deductibleVat)} will be claimed in Modelo 303.</p>}
              </div>}
            </div>
          </section>
          <section className="logbook-form-section">
            <h3>INVOICE ATTACHMENT</h3>
            <label className="logbook-wide logbook-upload-label">UPLOAD SOURCE DOCUMENT <span>PDF / JPG / PNG · MAX 2 MB</span>
              <span className="logbook-upload" onDragOver={(event) => event.preventDefault()} onDrop={dropAttachment}>
                {draft.attachment?.data && draft.attachment.type.startsWith('image/') ? <img className="logbook-upload-preview" src={draft.attachment.data} alt={`Preview of ${draft.attachment.name}`} /> : <Paperclip size={18} />}
                <span>{draft.attachment?.name || 'Drop invoice here or choose a file'}</span>
                <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={uploadAttachment} aria-label="Upload PDF invoice or JPEG/PNG receipt" />
              </span>
            </label>
            {draft.attachment && <div className="logbook-attachment-preview"><span>{draft.attachment.type === 'application/pdf' ? <FileText size={16} /> : <Image size={16} />}{draft.attachment.name} · {(draft.attachment.size / 1024).toFixed(0)} KB</span><button type="button" onClick={() => setDraft((previous) => ({ ...previous, attachment: null }))}>REMOVE</button></div>}
            {attachmentError && <p className="logbook-error" role="alert">{attachmentError}</p>}
          </section>
          <footer className="logbook-form-actions"><button type="button" className="logbook-secondary-button" onClick={onClose}>CANCEL</button><button className="logbook-primary-button" type="submit">SAVE ENTRY</button></footer>
        </form>
      </section>
    </div>
  )
}

function LogbookTable({ kind, records, onEdit, onDelete }) {
  return (
    <div className="logbook-table-scroll">
      <table className="logbook-table">
        <thead><tr><th>DATE OF ISSUE</th><th>INVOICE NO.</th><th>{kind === 'income' ? 'CLIENT' : 'SUPPLIER'}</th><th>NIF / CIF</th><th>STATUTORY CATEGORY</th><th>CONCEPT / DESCRIPTION</th><th>BASE IMPONIBLE</th><th>IVA %</th><th>DEDUCTIBLE %</th><th>DEDUCTIBLE BASE</th><th>DEDUCTIBLE IVA</th><th>IRPF %</th><th>TOTAL AMOUNT</th><th>ATTACHMENT</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {records.map((record) => <tr key={record.id}>
            <td>{csvDate(record.date)}</td><td className="logbook-number">{record.number}</td><td>{record.name}</td><td>{record.taxId}</td><td>{CATEGORY_LABELS[record.category] || '—'}</td><td className="logbook-concept">{record.concept}</td><td className="logbook-money">{formatMoney(record.baseTotal)}</td><td>{record.vatRate}%</td><td>{kind === 'expense' ? `${record.deductiblePercentage}%` : '—'}</td><td className="logbook-money">{kind === 'expense' ? formatMoney(getDeductibleBase(record)) : '—'}</td><td className="logbook-money">{kind === 'expense' ? formatMoney(getDeductibleVat(record)) : '—'}</td><td>{record.irpfRetentionRate}%</td><td className="logbook-money logbook-total">{formatMoney(getTotal(record))}</td>
            <td>{record.attachment?.data
              ? <a className="logbook-attachment" href={record.attachment.data} download={record.attachment.name} title={`Download ${record.attachment.name}`}><Paperclip size={13} /> {record.attachment.name}</a>
              : record.attachment
                ? <span className="logbook-no-attachment" title="This cloud attachment will be available when online">{record.attachment.name} · OFFLINE</span>
                : <span className="logbook-no-attachment">—</span>}</td>
            <td className="logbook-row-actions"><button type="button" title={`Edit ${record.number}`} aria-label={`Edit ${record.number}`} onClick={() => onEdit(record)}><FileText size={14} /></button><button type="button" title={`Delete ${record.number}`} aria-label={`Delete ${record.number}`} onClick={() => onDelete(record)}><Trash2 size={14} /></button></td>
          </tr>)}
          {!records.length && <tr><td className="logbook-empty" colSpan="15"><ReceiptText size={20} /><strong>NO ENTRIES IN THIS PERIOD</strong><span>Add an invoice or expense to start your ledger.</span></td></tr>}
        </tbody>
      </table>
    </div>
  )
}

export default function Logbook({ records, onRecordsChange }) {
  const [initialLedger] = useState(readRecords)
  const initialDate = currentDate()
  const [quarter, setQuarter] = useState(String(getQuarter(initialDate)))
  const [year, setYear] = useState(initialDate.slice(0, 4))
  const [activeTab, setActiveTab] = useState('income')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [storageError, setStorageError] = useState(initialLedger.error)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const years = [...new Set([Number(initialDate.slice(0, 4)), ...records.map((record) => Number(record.date.slice(0, 4)))])].sort((a, b) => b - a)
  const clients = useMemo(() => {
    const latestByTaxId = new Map()
    records
      .filter((record) => record.kind === 'income' && record.taxId.trim())
      .slice()
      .sort((left, right) => right.date.localeCompare(left.date))
      .forEach((record) => {
        const key = record.taxId.trim().toLocaleLowerCase()
        if (!latestByTaxId.has(key)) latestByTaxId.set(key, { ...record, key })
      })
    return [...latestByTaxId.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [records])
  const suppliers = useMemo(() => getLatestSuppliers(records), [records])
  const quarterSummaries = useMemo(() => [1, 2, 3, 4].map((quarterNumber) => {
    const quarterRecords = records.filter((record) =>
      record.date.slice(0, 4) === year && getQuarter(record.date) === quarterNumber,
    )
    const incomeRecords = quarterRecords.filter((record) => record.kind === 'income')
    const expenseRecords = quarterRecords.filter((record) => record.kind === 'expense')
    const income = roundMoney(incomeRecords.reduce((total, record) => total + getTotal(record), 0))
    const expenses = roundMoney(expenseRecords.reduce((total, record) => total + getTotal(record), 0))
    const net = roundMoney(
      incomeRecords.reduce((total, record) => total + Number(record.base), 0) -
      expenseRecords.reduce((total, record) => total + getDeductibleBase(record), 0),
    )
    return { quarter: quarterNumber, income, expenses, net, count: quarterRecords.length }
  }), [records, year])
  const filtered = useMemo(() => filterRecordsByPeriod(records, year, quarter), [quarter, records, year])
  const incomes = filtered.filter((record) => record.kind === 'income')
  const expenses = filtered.filter((record) => record.kind === 'expense')
  const metrics = getLedgerMetrics(incomes, expenses)
  const visibleRecords = activeTab === 'income' ? incomes : expenses

  function persistRecords(nextRecords) {
    onRecordsChange(nextRecords)
    try {
      localStorage.setItem(LOGBOOK_KEY, JSON.stringify(nextRecords))
      setStorageError('')
    } catch {
      setStorageError('Could not save your ledger. Remove large attachments or free browser storage and try again.')
    }
  }

  function saveRecord(draft) {
    if (editing) {
      persistRecords(records.map((record) => record.id === editing.id ? { ...draft, id: editing.id } : record))
    } else {
      persistRecords([...records, { ...draft, id: crypto.randomUUID() }])
    }
    setEditing(null)
    setCreating(false)
  }

  function deleteRecord() {
    if (!deleteTarget) return
    persistRecords(records.filter((record) => record.id !== deleteTarget.id))
    setDeleteTarget(null)
  }

  return (
    <section className="logbook">
      <header className="logbook-heading">
        <div><span className="logbook-kicker"><span className="logbook-live-dot" /> FISCAL RECORDS / {year} · {quarter === 'all' ? 'FULL YEAR' : `Q${quarter}`}</span><h1>LOGBOOK<span className="logbook-heading-period">.</span></h1><p>Invoices, expenses, and the numbers between them.</p></div>
        <div className="logbook-heading-actions">
          <label className="logbook-filter"><span>FISCAL PERIOD</span><select aria-label="Fiscal period" value={quarter} onChange={(event) => setQuarter(event.target.value)}><option value="all">FULL YEAR</option>{[1, 2, 3, 4].map((item) => <option key={item} value={item}>Q{item}</option>)}</select></label>
          <label className="logbook-filter"><span>YEAR</span><select aria-label="Fiscal year" value={year} onChange={(event) => setYear(event.target.value)}>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <button type="button" className="logbook-export-button" onClick={() => downloadCsv(filtered, quarter, year)}><Download size={15} /> [ EXPORT TO CSV ]</button>
        </div>
      </header>
      <section className="logbook-year-overview" aria-label={`All quarters in ${year}`}>
        <header><span>YEAR AT A GLANCE</span><strong>{year}</strong><small>Select a quarter to inspect its ledger below.</small></header>
        <div className="logbook-quarter-grid">
          {quarterSummaries.map((summary) => (
            <button
              type="button"
              key={summary.quarter}
              className={`logbook-quarter-card ${quarter === String(summary.quarter) ? 'active' : ''}`}
              aria-pressed={quarter === String(summary.quarter)}
              onClick={() => setQuarter(String(summary.quarter))}
            >
              <span className="logbook-quarter-card-heading"><strong>Q{summary.quarter}</strong><small>{summary.count} RECORD{summary.count === 1 ? '' : 'S'}</small></span>
              <span><small>INCOME</small><strong>{formatMoney(summary.income)}</strong></span>
              <span><small>EXPENSES</small><strong>{formatMoney(summary.expenses)}</strong></span>
              <span className="logbook-quarter-net"><small>NET</small><strong>{formatMoney(summary.net)}</strong></span>
            </button>
          ))}
          <button
            type="button"
            className={`logbook-quarter-card logbook-full-year-card ${quarter === 'all' ? 'active' : ''}`}
            aria-pressed={quarter === 'all'}
            onClick={() => setQuarter('all')}
          >
            <span className="logbook-quarter-card-heading"><strong>FULL YEAR {year}</strong><small>{quarterSummaries.reduce((count, summary) => count + summary.count, 0)} RECORDS</small></span>
            <span><small>INCOME</small><strong>{formatMoney(quarterSummaries.reduce((total, summary) => total + summary.income, 0))}</strong></span>
            <span><small>EXPENSES</small><strong>{formatMoney(quarterSummaries.reduce((total, summary) => total + summary.expenses, 0))}</strong></span>
            <span className="logbook-quarter-net"><small>NET PROFIT · EXCL. IVA</small><strong>{formatMoney(quarterSummaries.reduce((total, summary) => total + summary.net, 0))}</strong></span>
          </button>
        </div>
      </section>
      <section className="logbook-summary" aria-label={`${quarter === 'all' ? 'Full year' : `Quarter ${quarter}`} totals`}>
        <article><span>TOTAL INCOME</span><strong>{formatMoney(metrics.income)}</strong><small>INCL. VAT − WITHHOLDING</small></article>
        <article><span>TOTAL IVA COLLECTED</span><strong>{formatMoney(metrics.vatCollected)}</strong><small>OUTPUT TAX · INVOICES</small></article>
        <article><span>TOTAL EXPENSES</span><strong>{formatMoney(metrics.expenses)}</strong><small>INCL. VAT − WITHHOLDING</small></article>
        <article><span>TOTAL IVA PAID</span><strong>{formatMoney(metrics.vatPaid)}</strong><small>INPUT TAX · EXPENSES</small></article>
        <article className="logbook-net-profit"><span>NET PROFIT</span><strong>{formatMoney(metrics.netProfit)}</strong><small>INCOME BASE − DEDUCTIBLE EXPENSE BASE · EXCL. IVA</small></article>
      </section>
      {storageError && <p className="logbook-storage-error" role="alert">{storageError}</p>}
      <div className="logbook-ledger-toolbar">
        <div className="logbook-tabs" role="tablist" aria-label="Ledger type">
          <button type="button" role="tab" aria-selected={activeTab === 'income'} className={activeTab === 'income' ? 'active' : ''} onClick={() => setActiveTab('income')}>INVOICES / INCOME <span>{incomes.length.toString().padStart(2, '0')}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'expenses'} className={activeTab === 'expenses' ? 'active' : ''} onClick={() => setActiveTab('expenses')}>EXPENSES <span>{expenses.length.toString().padStart(2, '0')}</span></button>
        </div>
        <button type="button" className="logbook-add-button" onClick={() => setCreating(true)}><Plus size={15} /> NEW {activeTab === 'income' ? 'INVOICE' : 'EXPENSE'}</button>
      </div>
      <LogbookTable kind={activeTab} records={visibleRecords} onEdit={setEditing} onDelete={setDeleteTarget} />
      <footer className="logbook-footnote"><span>LEDGER · AUTO-SAVED</span><span>{filtered.length} RECORD{filtered.length === 1 ? '' : 'S'} · {quarter === 'all' ? `FULL YEAR ${year}` : `Q${quarter} ${year}`}</span></footer>
      {(creating || editing) && <LogbookForm record={editing} initialKind={activeTab === 'income' ? 'income' : 'expense'} clients={clients} suppliers={suppliers} onClose={() => { setEditing(null); setCreating(false) }} onSave={saveRecord} />}
      {deleteTarget && <div className="logbook-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null) }}><section className="logbook-confirm" role="alertdialog" aria-modal="true" aria-labelledby="logbook-delete-title"><button type="button" className="logbook-icon-button" aria-label="Cancel delete" onClick={() => setDeleteTarget(null)}><X size={18} /></button><span className="logbook-kicker">PERMANENT ACTION</span><h2 id="logbook-delete-title">Delete {deleteTarget.number}?</h2>            <p>This entry and its attachment will be removed from this device and, when signed in, your cloud account.</p><footer className="logbook-form-actions"><button type="button" className="logbook-secondary-button" onClick={() => setDeleteTarget(null)}>KEEP ENTRY</button><button type="button" className="logbook-danger-button" onClick={deleteRecord}>DELETE ENTRY</button></footer></section></div>}
    </section>
  )
}
