import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Archive,
  ArrowDownUp,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Circle,
  Command,
  BriefcaseBusiness,
  Calculator,
  Download,
  Focus,
  GripVertical,
  House,
  Inbox,
  ListTodo,
  NotebookPen,
  Pencil,
  Pin,
  Plus,
  Shapes,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { addDays, dateKey, formatRange, getBizkaiaTaxDeadline, getMultiDayEventSegments, getNextUpcomingEvent, isFixedEvent, recordFrogChange, recordScheduleChange, returnOverdueTasks, startOfDay, timelineDates } from './plannerDates'
import { LOGBOOK_KEY, TASKS_KEY, createBackup, parseBackup } from './dataBackup'
import Logbook from './Logbook.jsx'
import CloudAccount from './CloudAccount.jsx'
import { useFirebaseAuth } from './firebaseAuthContext.js'
import { useFirebaseSync } from './firebaseSync.js'
import { prioritizePlannerCollisions } from './plannerDnd.js'
import './App.css'
import './ArtDirection.css'

const NOTES_KEY = 'elemental-planner-notes-v1'
const XP_KEY = 'elemental-planner-xp-v1'
const HISTORY_KEY = 'elemental-planner-history-v1'
const FROG_REWARD_XP = 25

const categories = {
  'client-work': { label: 'Client Work', icon: BriefcaseBusiness },
  'admin-finance': { label: 'Admin & Finance', icon: Calculator },
  'creative-projects': { label: 'Creative Projects', icon: Shapes },
  'personal-life': { label: 'Personal & Life', icon: House },
}

const legacyCategoryMap = {
  earth: 'admin-finance',
  water: 'creative-projects',
  fire: 'client-work',
  air: 'personal-life',
}

function categoryForRecord(record) {
  if (Object.hasOwn(categories, record.category)) return record.category
  const context = [record.title, record.project]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (/\b(personal|family|health|home|errand|life)\b/.test(context)) return 'personal-life'
  if (/\b(admin|finance|invoice|bill|tax|expense|accounting|archive|planning|schedule)\b/.test(context)) return 'admin-finance'
  if (/\b(client|customer|campaign|proposal|landing page|deliverable|check-in)\b/.test(context)) return 'client-work'
  if (/\b(creative|design|visual|workshop|outline|art|brand|studio)\b/.test(context)) return 'creative-projects'
  return legacyCategoryMap[record.category] || 'personal-life'
}

const priorities = ['Low', 'Normal', 'High']

function startOfWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7))
  return result
}

function initialItems() {
  const today = new Date()
  const monday = startOfWeek(today)
  const at = (day) => dateKey(addDays(monday, day))
  return [
    { id: crypto.randomUUID(), title: 'Weekly studio planning', type: 'event', category: 'admin-finance', priority: 'Normal', project: 'Studio', duration: 45, date: at(0), time: '09:30', order: 0, status: 'scheduled', location: 'Studio call' },
    { id: crypto.randomUUID(), title: 'Review campaign direction', type: 'task', category: 'creative-projects', priority: 'High', project: 'Northstar', duration: 90, date: at(0), time: null, order: 1, status: 'scheduled', dueDate: at(2) },
    { id: crypto.randomUUID(), title: 'Client check-in', type: 'event', category: 'client-work', priority: 'Normal', project: 'Northstar', duration: 60, date: at(1), time: '10:00', order: 0, status: 'scheduled', location: 'Meet link' },
    { id: crypto.randomUUID(), title: 'Shape the landing page', type: 'task', category: 'client-work', priority: 'High', project: 'Northstar', duration: 120, date: at(1), time: null, order: 1, status: 'scheduled', dueDate: at(4) },
    { id: crypto.randomUUID(), title: 'Send invoice to Marta', type: 'task', category: 'admin-finance', priority: 'Normal', project: 'Admin', duration: 30, date: null, time: null, order: 0, status: 'ready', dueDate: at(3) },
    { id: crypto.randomUUID(), title: 'Collect visual references', type: 'task', category: 'creative-projects', priority: 'Low', project: 'Fieldnotes', duration: 60, date: null, time: null, order: 1, status: 'ready' },
    { id: crypto.randomUUID(), title: 'Prepare workshop outline', type: 'task', category: 'creative-projects', priority: 'Normal', project: 'Fieldnotes', duration: 90, date: null, time: null, order: 2, status: 'ready', dueDate: at(5) },
    { id: crypto.randomUUID(), title: 'Update project archive', type: 'task', category: 'admin-finance', priority: 'Low', project: 'Studio', duration: 45, date: null, time: null, order: 3, status: 'inbox' },
  ]
}

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback()
  } catch {
    return fallback()
  }
}

function normalizeItems(records) {
  return records.map((record, index) => {
    const { scheduledStart, ...item } = record
    const legacyDate = typeof scheduledStart === 'string' ? scheduledStart.slice(0, 10) : null
    const legacyTime = typeof scheduledStart === 'string' ? scheduledStart.slice(11, 16) : null
    const date = typeof item.date === 'string' ? item.date : legacyDate
    const time = typeof item.time === 'string' ? item.time : legacyTime
    const fixedEvent = isFixedEvent({ date, time })
    return {
      ...item,
      title: typeof item.title === 'string' ? item.title : '',
      type: fixedEvent ? 'event' : 'task',
      project: typeof item.project === 'string' ? item.project : '',
      description: typeof item.description === 'string' ? item.description : '',
      location: typeof item.location === 'string' ? item.location : '',
      dueDate: typeof item.dueDate === 'string' ? item.dueDate : '',
      category: categoryForRecord(item),
      priority: priorities.includes(item.priority) ? item.priority : 'Normal',
      duration: Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 60,
      date: date || null,
      endDate: fixedEvent && typeof item.endDate === 'string' ? item.endDate : null,
      time: fixedEvent ? time : null,
      order: Number.isFinite(item.order) ? item.order : index,
      frogDate: item.frogDate ?? null,
      xpAwarded: Boolean(item.xpAwarded),
    }
  })
}

function getFrogForDate(items, targetDate, includeCompleted = false) {
  return items.find((item) => item.type === 'task' && item.frogDate === targetDate && item.status !== 'completed') ??
    (includeCompleted ? items.find((item) => item.type === 'task' && item.frogDate === targetDate) : null) ??
    null
}

function CategoryMark({ category, size = 15 }) {
  const CategoryIcon = categories[category]?.icon || categories['personal-life'].icon
  return <CategoryIcon size={size} aria-hidden="true" />
}

function CompletionCheckbox({ item, onToggleComplete }) {
  const completed = item.status === 'completed'
  return (
    <button
      type="button"
      className={`completion-checkbox ${completed ? 'checked' : ''}`}
      role="checkbox"
      aria-checked={completed}
      aria-label={`${completed ? 'Mark active' : 'Complete'} ${item.title}`}
      title={completed ? 'Mark active' : 'Complete task'}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onToggleComplete(item.id) }}
    >
      {completed && <Check size={13} />}
    </button>
  )
}

function TaxDeadlineCard({ deadline, compact = false }) {
  return (
    <article className={`tax-deadline-card ${compact ? 'is-compact' : ''}`} aria-label={`Bizkaia tax deadline: ${deadline.title}`}>
      <span className="tax-deadline-label"><span aria-hidden="true">!</span> BIZKAIA TAX DEADLINE</span>
      <strong>{deadline.title}</strong>
      <span className="tax-deadline-date">{new Date(`${deadline.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
    </article>
  )
}

function ItemCard({ item, onEdit, onToggleComplete, onDelete, dropTarget = true, dropDate = item.date }) {
  const fixedEvent = isFixedEvent(item)
  const draggable = useDraggable({ id: item.id, data: { itemId: item.id }, disabled: fixedEvent })
  const drop = useDroppable({ id: `item-${item.id}-${dropDate}`, data: { kind: 'item', itemId: item.id, date: dropDate }, disabled: !dropDate || !dropTarget })
  const category = categories[item.category] || categories['personal-life']
  const isFrog = Boolean(item.frogDate) && item.type === 'task'
  const setCardRef = (node) => {
    draggable.setNodeRef(node)
    drop.setNodeRef(node)
  }

  return (
    <article
      ref={setCardRef}
      className={`item-card ${fixedEvent ? 'is-event' : `is-${item.category}`} ${item.status === 'completed' ? 'is-complete' : ''} ${isFrog ? 'is-frog frog-card' : ''} ${item.date ? 'is-scheduled' : ''} ${drop.isOver ? 'is-over' : ''}`}
      style={{ transform: !draggable.isDragging && draggable.transform ? `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` : undefined, opacity: draggable.isDragging ? 0.16 : 1 }}
      {...draggable.attributes}
      {...draggable.listeners}
      role="group"
      onClick={() => onEdit(item)}
    >
      {isFrog ? <>
        <div className="frog-card-label"><span className="frog-index">01</span> DAILY PRIORITY</div>
        <div className="frog-card-title">{item.title}</div>
        <div className="frog-card-bottom">
          <span className="frog-card-meta"><CategoryMark category={item.category} size={13} /> {category.label} · {item.duration} min{item.project ? ` · ${item.project}` : ''}</span>
          <CompletionCheckbox item={item} onToggleComplete={onToggleComplete} />
        </div>
      </> : <>
        <div className="item-card-top">
          <span className={`item-icon category-${item.category}`} title={category.label} aria-label={category.label}><CategoryMark category={item.category} /></span>
          <span className="item-title">{item.title}</span>
          {fixedEvent && <span className="fixed-mark"><CalendarDays size={11} /> FIXED</span>}
          {!fixedEvent && <CompletionCheckbox item={item} onToggleComplete={onToggleComplete} />}
          <span className="drag-handle" aria-hidden="true"><GripVertical size={14} /></span>
        </div>
        {fixedEvent && <div className="event-time">{item.time}</div>}
        <div className="item-meta">
          <span className="category-meta"><CategoryMark category={item.category} size={12} /> {category.label}</span>
          <span>{item.duration} min{item.project ? ` · ${item.project}` : ''}</span>
          {item.dueDate && <span className="deadline-meta">Due {new Date(`${item.dueDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
        </div>
      </>}
      {!item.date && <div className="pool-card-tools"><span className={`priority priority-${item.priority.toLowerCase()}`}>{item.priority}</span><button aria-label={fixedEvent ? 'Delete event' : 'Delete task'} title={fixedEvent ? 'Delete event' : 'Delete task'} onClick={(event) => { event.stopPropagation(); onDelete(item.id) }}><Trash2 size={13} /></button></div>}
    </article>
  )
}

function DragPreview({ item, width }) {
  const fixedEvent = isFixedEvent(item)
  const category = categories[item.category] || categories['personal-life']
  const isFrog = Boolean(item.frogDate) && item.type === 'task'

  return (
    <article
      className={`item-card drag-overlay-card ${fixedEvent ? 'is-event' : `is-${item.category}`} ${item.status === 'completed' ? 'is-complete' : ''} ${isFrog ? 'is-frog frog-card' : ''} ${item.date ? 'is-scheduled' : ''}`}
      style={{ width: width || undefined }}
      aria-hidden="true"
    >
      {isFrog
        ? <>
            <div className="frog-card-label"><span className="frog-index">01</span> DAILY PRIORITY</div>
            <div className="frog-card-title">{item.title}</div>
            <div className="frog-card-bottom">
              <span className="frog-card-meta"><CategoryMark category={item.category} size={13} /> {category.label} · {item.duration} min{item.project ? ` · ${item.project}` : ''}</span>
            </div>
          </>
        : <>
            <div className="item-card-top">
              <span className={`item-icon category-${item.category}`}><CategoryMark category={item.category} /></span>
              <span className="item-title">{item.title}</span>
              {fixedEvent && <span className="fixed-mark"><CalendarDays size={11} /> FIXED</span>}
              {!fixedEvent && <span className="drag-handle" aria-hidden="true"><GripVertical size={14} /></span>}
            </div>
            {fixedEvent && <div className="event-time">{item.time}</div>}
            <div className="item-meta">
              <span className="category-meta"><CategoryMark category={item.category} size={12} /> {category.label}</span>
              <span>{item.duration} min{item.project ? ` · ${item.project}` : ''}</span>
              {item.dueDate && <span className="deadline-meta">Due {new Date(`${item.dueDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
            </div>
          </>}
    </article>
  )
}

function MultiDayEventCard({ segment, onEdit, compact = false }) {
  const { item, startIndex, endIndex, row, lane } = segment
  const firstVisibleDate = segment.startDate === item.date
  const lastVisibleDate = segment.endDate === item.endDate
  const startTime = item.time || 'ALL DAY'
  const endDate = new Date(`${item.endDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const style = compact
    ? { gridColumn: `${startIndex % 7 + 1} / ${((endIndex - 1) % 7) + 2}`, gridRow: row + 1, top: `${31 + lane * 38}px` }
    : { gridColumn: `${startIndex + 1} / ${endIndex + 1}`, gridRow: 1, top: `${216 + (segment.hasLeadingItem ? 96 : 0) + lane * 118}px` }
  return (
    <button
      type="button"
      className={`multi-day-event ${compact ? 'is-compact' : ''} ${firstVisibleDate ? 'starts-event' : ''} ${lastVisibleDate ? 'ends-event' : ''}`}
      style={style}
      title={`${item.title} · ${item.date}–${item.endDate}`}
      onClick={() => onEdit(item)}
    >
      {compact
        ? <><strong>{item.time}</strong><span>{item.title}</span></>
        : <>
          <span className="multi-day-event-primary"><strong>{startTime}</strong><span>{item.title}</span></span>
          <span className="multi-day-event-metadata">
            <span>ENDS {endDate}</span>
            <span>{item.duration} MIN</span>
            <span className="multi-day-event-project">{item.project || 'NO PROJECT'}</span>
          </span>
        </>}
    </button>
  )
}

function DropZone({ id, data, className, dateKeyValue, children, disabled = false }) {
  const drop = useDroppable({ id, data, disabled })
  return <div ref={drop.setNodeRef} data-date={dateKeyValue} className={`${className} ${drop.isOver ? 'is-over' : ''}`}>{children}</div>
}

function plannerCollisionDetection(args) {
  return prioritizePlannerCollisions(pointerWithin(args), args.droppableContainers)
}

function MonthItem({ item, onEdit, onToggleComplete }) {
  const fixedEvent = isFixedEvent(item)
  const draggable = useDraggable({ id: item.id, data: { itemId: item.id }, disabled: fixedEvent })
  const deadline = item.type === 'task' && item.dueDate
  const overdue = deadline && item.dueDate < dateKey(new Date())
  const isFrog = item.type === 'task' && Boolean(item.frogDate)
  const category = categories[item.category] || categories['personal-life']
  const categoryDescription = `${category.label}${fixedEvent ? ' · Fixed event' : ''}`
  return (
    <article
      ref={draggable.setNodeRef}
      style={{ transform: draggable.transform ? `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` : undefined, opacity: draggable.isDragging ? 0.4 : 1 }}
      className={`month-item ${fixedEvent ? 'month-event' : `month-${item.category}`} ${deadline ? 'month-deadline' : ''} ${overdue ? 'is-overdue' : ''} ${isFrog ? 'is-frog' : ''}`}
      title={fixedEvent
        ? `${categoryDescription} · ${item.title} · ${item.date}${item.time ? ` · ${item.time}` : ''}`
        : `${categoryDescription} · ${item.title} · ${deadline ? `due ${item.dueDate}` : `${item.duration} min`}`}
    >
      <button className="month-item-content" type="button" {...draggable.attributes} {...draggable.listeners} onClick={() => onEdit(item)}>
        <span className={`month-category-icon category-${item.category}`} aria-label={category.label} title={category.label}><CategoryMark category={item.category} size={12} /></span>
        {fixedEvent && <strong className="month-item-time">{item.time}</strong>}
        <span className="month-item-title">{item.title}</span>
        <span className={`month-category-label category-${item.category}`}>{category.label}</span>
      </button>
      {!fixedEvent && <CompletionCheckbox item={item} onToggleComplete={onToggleComplete} />}
    </article>
  )
}

function MonthGrid({ monthDate, items, onSelectDate, onEdit, onToggleComplete }) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const gridStart = addDays(first, -offset)
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
  const multiDayEventSegments = getMultiDayEventSegments(items, days, 7)
  const rowLaneCounts = Array.from({ length: 6 }, (_, row) =>
    Math.max(0, ...multiDayEventSegments.filter((segment) => segment.row === row).map((segment) => segment.lane + 1)),
  )
  return (
    <div className="month-grid-wrap">
      <div className="month-grid weekday-row">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div key={day}>{day}</div>)}</div>
      <div className="month-grid month-days">
        {days.map((day, dayIndex) => {
          const key = dateKey(day)
          const row = Math.floor(dayIndex / 7)
          const taxDeadline = getBizkaiaTaxDeadline(day)
          const dayItems = items.filter((item) => isFixedEvent(item) && item.date === key && !(item.endDate > item.date))
            .sort((a, b) => (a.order || 0) - (b.order || 0))
          return <DropZone key={key} id={`month-${key}`} data={{ date: key, minutes: 9 * 60, kind: 'month' }} className={`month-cell ${day.getDay() === 0 || day.getDay() === 6 ? 'is-weekend' : ''} ${day.getMonth() !== monthDate.getMonth() ? 'out-month' : ''} ${key === dateKey(new Date()) ? 'today-cell' : ''}`} disabled>
            <button className="month-date" onClick={() => onSelectDate(day)}>{day.getDate()}</button>
            {rowLaneCounts[row] > 0 && <div className="month-event-spacer" style={{ height: `${rowLaneCounts[row] * 38}px` }} />}
            {taxDeadline && <TaxDeadlineCard deadline={taxDeadline} compact />}
            <div className="month-items">
              {dayItems.slice(0, 3).map((item) => <MonthItem key={item.id} item={item} onEdit={onEdit} onToggleComplete={onToggleComplete} />)}
              {dayItems.length > 3 && <button className="more-items" onClick={() => onSelectDate(day)}>+{dayItems.length - 3} more</button>}
            </div>
          </DropZone>
        })}
        {multiDayEventSegments.map((segment) => <MultiDayEventCard key={`${segment.item.id}-${segment.row}-${segment.startIndex}`} segment={segment} onEdit={onEdit} compact />)}
      </div>
    </div>
  )
}

function TaskFormModal({ item, onSave, onClose, onDelete }) {
  const [draft, setDraft] = useState(() => ({
    ...item,
    title: typeof item.title === 'string' ? item.title : '',
    category: categories[item.category] ? item.category : 'client-work',
    priority: priorities.includes(item.priority) ? item.priority : 'Normal',
    duration: Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 60,
    date: item.date || '',
    endDate: item.endDate || '',
    time: item.time || '',
    dueDate: item.dueDate || '',
    project: item.project || '',
    description: item.description || '',
  }))

  function updateField(event) {
    const { name, value } = event.target
    setDraft((current) => {
      const updated = { ...current, [name]: value }
      if (name === 'date' || name === 'time') {
        updated.type = updated.date && updated.time ? 'event' : 'task'
        if (updated.type === 'task') updated.endDate = ''
      }
      return updated
    })
  }

  function submit(event) {
    event.preventDefault()
    onSave(draft)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="edit-modal" onSubmit={submit}>
        <div className="modal-heading"><div><span className="eyebrow">{item.id ? 'ITEM DETAILS' : 'NEW TASK OR EVENT'}</span><h2>{item.id ? 'A few details.' : 'Make a plan.'}</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
        <label>Title<input name="title" autoFocus value={draft.title} onChange={updateField} placeholder="What needs your attention?" required /></label>
        <fieldset className="category-fieldset">
          <legend>Category</legend>
          <div className="category-options" role="radiogroup" aria-label="Task category">
            {Object.entries(categories).map(([key, category]) => (
              <label key={key} className={`category-choice category-${key} ${draft.category === key ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="category"
                  value={key}
                  checked={draft.category === key}
                  onChange={updateField}
                />
                <CategoryMark category={key} size={20} />
                <span>{category.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="duration-field">Duration (minutes)<input name="duration" type="number" min="30" step="30" value={draft.duration} onChange={updateField} /></label>
        {draft.type === 'task' && <label>Deadline<input name="dueDate" type="date" value={draft.dueDate} onChange={updateField} /></label>}
        <fieldset className="scheduling-fieldset">
          <legend>Scheduling options</legend>
          <div className="form-row schedule-fields">
            <label>Start date<input name="date" type="date" value={draft.date} onChange={updateField} /></label>
            {draft.type === 'event' && <label>End date<input name="endDate" type="date" min={draft.date || undefined} value={draft.endDate} onChange={updateField} /></label>}
            <label>Time<input name="time" type="time" value={draft.time} onChange={updateField} /></label>
          </div>
          <div className="form-row"><label>Project or client<input name="project" value={draft.project} onChange={updateField} placeholder="Optional" /></label><label>Priority<select name="priority" value={draft.priority} onChange={updateField}>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select></label></div>
        </fieldset>
        {draft.type === 'task'
          ? <p className="schedule-help">Leave date and time blank for a flexible Quest Deck task. A date without a time is a movable planned task.</p>
          : <p className="schedule-help">Adding a start date and time makes this a fixed event. Use the end date to span multiple days.</p>}
        {draft.type === 'event' && <label>Location or link<input name="location" value={draft.location || ''} onChange={updateField} placeholder="Optional" /></label>}
        <label>Notes<textarea name="description" value={draft.description} onChange={updateField} placeholder="A little context, if useful" rows={3} /></label>
        <div className="modal-actions">{item.id && <button type="button" className="delete-button" title="Delete this task or event" onClick={() => onDelete(item.id)}><Trash2 size={14} /> Delete</button>}<button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button"><Check size={15} /> {item.id ? 'Save changes' : 'Create Task'}</button></div>
      </form>
    </div>
  )
}

function App() {
  const [items, setItems] = useState(() => returnOverdueTasks(normalizeItems(readStored(TASKS_KEY, initialItems)), dateKey(new Date())))
  const [notes, setNotes] = useState(() => readStored(NOTES_KEY, () => []))
  const [xp, setXp] = useState(() => Number(readStored(XP_KEY, () => 0)) || 0)
  const [history, setHistory] = useState(() => readStored(HISTORY_KEY, () => []))
  const [logbook, setLogbook] = useState(() => {
    const records = readStored(LOGBOOK_KEY, () => [])
    return Array.isArray(records) ? records : []
  })
  const [showArchived, setShowArchived] = useState(false)
  const [weekStart, setWeekStart] = useState(() => startOfDay(new Date()))
  const [monthDate, setMonthDate] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [activeView, setActiveView] = useState('week')
  const [activeTab, setActiveTab] = useState('ready')
  const [poolOpen, setPoolOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches)
  const [focusMode, setFocusMode] = useState(false)
  const [mobileDay, setMobileDay] = useState(dateKey(new Date()))
  const [taskDraft, setTaskDraft] = useState('')
  const [captureDraft, setCaptureDraft] = useState('')
  const [editing, setEditing] = useState(null)
  const [conversion, setConversion] = useState(null)
  const [toast, setToast] = useState('')
  const [clock, setClock] = useState(() => new Date())
  const [undoItems, setUndoItems] = useState(null)
  const [isDraggingToDeck, setIsDraggingToDeck] = useState(false)
  const [draggedItem, setDraggedItem] = useState(null)
  const [draggedItemWidth, setDraggedItemWidth] = useState(null)
  const [timelineBefore, setTimelineBefore] = useState(0)
  const [timelineAfter, setTimelineAfter] = useState(0)
  const [logCaptureId, setLogCaptureId] = useState(null)
  const [logHovered, setLogHovered] = useState(false)
  const [logFocused, setLogFocused] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [editingCaptureId, setEditingCaptureId] = useState(null)
  const [archiveDraft, setArchiveDraft] = useState('')
  const [backupError, setBackupError] = useState('')
  const { user, loading: authLoading, error: authError, signIn, signOut, clearError: clearAuthError, configured } = useFirebaseAuth()
  const captureRef = useRef(null)
  const backupInputRef = useRef(null)
  const calendarScrollRef = useRef(null)
  const pendingTimelineAdjustment = useRef(null)
  const pendingCalendarScrollRestore = useRef(null)
  const preservePlannerDateOnOpen = useRef(false)
  const dragScrollFrame = useRef(null)
  const dragScrollDirection = useRef(0)
  const dragScrollTimestamp = useRef(0)
  const dragPointer = useRef(null)
  const isLoadingTimeline = useRef(false)
  const syncData = useMemo(() => ({ tasks: items, notes, xp, history, logbook }), [items, notes, xp, history, logbook])
  const syncSetters = useMemo(() => ({ tasks: setItems, notes: setNotes, xp: setXp, history: setHistory, logbook: setLogbook }), [])
  const { status: syncStatus, error: syncError, clearError: clearSyncError } = useFirebaseSync({
    user,
    data: syncData,
    setters: syncSetters,
  })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor))
  const dates = useMemo(() => timelineDates(weekStart, timelineBefore, timelineAfter), [weekStart, timelineBefore, timelineAfter])
  const multiDayEventSegments = useMemo(() => {
    const segments = getMultiDayEventSegments(items, dates)
    return segments.map((segment) => ({
      ...segment,
      hasLeadingItem: dates.slice(segment.startIndex, segment.endIndex).some((day) => {
        const key = dateKey(day)
        const frog = getFrogForDate(items, key, true)
        return items.some((item) => item.date === key &&
          item.id !== frog?.id && !(isFixedEvent(item) && item.endDate > item.date))
      }),
    }))
  }, [items, dates])
  const weekEnd = dates[dates.length - 1]
  const currentDayKey = dateKey(clock)
  const lastTodayKey = useRef(currentDayKey)
  const activeCaptures = useMemo(() => notes
    .filter((note) => !note.archived && note.text?.trim())
    .sort((left, right) => right.updatedAt - left.updatedAt), [notes])
  const activeCaptureIndex = Math.max(0, activeCaptures.findIndex((note) => note.id === logCaptureId))
  const logCapture = activeCaptures[activeCaptureIndex]
  const nextEvent = useMemo(() => getNextUpcomingEvent(items, clock), [items, clock])

  useEffect(() => {
    if (activeView !== 'week' || archiveOpen || logHovered || logFocused || activeCaptures.length < 2) return undefined
    const timer = window.setInterval(() => {
      setLogCaptureId((currentId) => {
        const currentIndex = activeCaptures.findIndex((capture) => capture.id === currentId)
        return activeCaptures[(currentIndex < 0 ? 0 : currentIndex + 1) % activeCaptures.length].id
      })
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [activeCaptures, activeView, archiveOpen, logFocused, logHovered])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const showTimelineAt = useCallback((date, centerDate = false) => {
    const start = startOfDay(date)
    const targetDate = dateKey(start)
    setWeekStart(start)
    setMobileDay(targetDate)
    setTimelineBefore(0)
    setTimelineAfter(0)
    pendingTimelineAdjustment.current = null
    isLoadingTimeline.current = false
    window.requestAnimationFrame(() => {
      if (centerDate) {
        calendarScrollRef.current?.querySelector(`[data-date="${targetDate}"]`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        })
      } else {
        calendarScrollRef.current?.scrollTo({ left: 0 })
      }
    })
  }, [])

  const goToToday = useCallback(() => {
    showTimelineAt(new Date(), true)
  }, [showTimelineAt])

  const stopDragAutoScroll = useCallback(() => {
    dragScrollDirection.current = 0
    dragPointer.current = null
    dragScrollTimestamp.current = 0
    setIsDraggingToDeck(false)
    if (dragScrollFrame.current !== null) {
      window.cancelAnimationFrame(dragScrollFrame.current)
      dragScrollFrame.current = null
    }
  }, [])

  const handleDragMove = useCallback((event) => {
    const activator = event.activatorEvent
    const calendar = calendarScrollRef.current
    const taskPool = document.querySelector('.task-pool')
    if (!calendar || !activator || !('clientX' in activator) || !('clientY' in activator)) {
      dragScrollDirection.current = 0
      return
    }

    const delta = event.delta
    const pointer = { x: activator.clientX + delta.x, y: activator.clientY + delta.y }
    dragPointer.current = pointer
    const calendarBounds = calendar.getBoundingClientRect()
    const deckBounds = taskPool?.getBoundingClientRect()
    const overDeck = Boolean(deckBounds &&
      pointer.x >= deckBounds.left && pointer.x <= deckBounds.right &&
      pointer.y >= deckBounds.top && pointer.y <= deckBounds.bottom)
    setIsDraggingToDeck(overDeck)

    if (overDeck || pointer.y < calendarBounds.top || pointer.y > calendarBounds.bottom) {
      dragScrollDirection.current = 0
      return
    }

    const edgeWidth = Math.min(20, calendarBounds.width * 0.05)
    dragScrollDirection.current = pointer.x <= calendarBounds.left + edgeWidth
      ? -1
      : pointer.x >= calendarBounds.right - edgeWidth ? 1 : 0
  }, [])

  useEffect(() => {
    const scrollAtEdge = (timestamp) => {
      const calendar = calendarScrollRef.current
      const pointer = dragPointer.current
      if (!calendar || !pointer || !dragScrollDirection.current) {
        dragScrollFrame.current = null
        dragScrollTimestamp.current = 0
        return
      }

      const taskPool = document.querySelector('.task-pool')
      const deckBounds = taskPool?.getBoundingClientRect()
      const overDeck = Boolean(deckBounds &&
        pointer.x >= deckBounds.left && pointer.x <= deckBounds.right &&
        pointer.y >= deckBounds.top && pointer.y <= deckBounds.bottom)
      if (overDeck) {
        dragScrollDirection.current = 0
        setIsDraggingToDeck(true)
        dragScrollFrame.current = null
        dragScrollTimestamp.current = 0
        return
      }

      const elapsed = dragScrollTimestamp.current
        ? Math.min(timestamp - dragScrollTimestamp.current, 32)
        : 0
      dragScrollTimestamp.current = timestamp
      calendar.scrollLeft += dragScrollDirection.current * elapsed * 0.18
      dragScrollFrame.current = window.requestAnimationFrame(scrollAtEdge)
    }

    if (dragScrollDirection.current && dragScrollFrame.current === null) {
      dragScrollTimestamp.current = 0
      dragScrollFrame.current = window.requestAnimationFrame(scrollAtEdge)
    }
    return () => {
      if (dragScrollFrame.current !== null && !dragScrollDirection.current) {
        window.cancelAnimationFrame(dragScrollFrame.current)
        dragScrollFrame.current = null
        dragScrollTimestamp.current = 0
      }
    }
  }, [isDraggingToDeck])

  function navigateTimeline(direction) {
    const scroller = calendarScrollRef.current
    if (!scroller) {
      showTimelineAt(addDays(weekStart, direction * 7))
      return
    }
    const atStart = scroller.scrollLeft <= 8
    const atEnd = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft <= 8
    if (direction < 0 && atStart) {
      pendingTimelineAdjustment.current = { scrollLeft: scroller.scrollLeft, scrollWidth: scroller.scrollWidth, mode: 'start' }
      isLoadingTimeline.current = true
      setTimelineBefore((count) => count + 1)
    } else if (direction > 0 && atEnd) {
      pendingTimelineAdjustment.current = { scrollLeft: scroller.scrollLeft, scrollWidth: scroller.scrollWidth, mode: 'next' }
      isLoadingTimeline.current = true
      setTimelineAfter((count) => count + 1)
    } else {
      scroller.scrollBy({ left: direction * scroller.clientWidth * 0.82, behavior: 'smooth' })
    }
  }

  function extendTimeline(event) {
    const scroller = event.currentTarget
    if (isLoadingTimeline.current) return
    if (scroller.scrollLeft < 220) {
      pendingTimelineAdjustment.current = { scrollLeft: scroller.scrollLeft, scrollWidth: scroller.scrollWidth, mode: 'preserve' }
      isLoadingTimeline.current = true
      setTimelineBefore((count) => count + 1)
    } else if (scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft < 220) {
      isLoadingTimeline.current = true
      setTimelineAfter((count) => count + 1)
    }
  }

  function shiftMobileDay(amount) {
    showTimelineAt(addDays(new Date(`${mobileDay}T12:00:00`), amount))
  }

  useLayoutEffect(() => {
    const pending = pendingTimelineAdjustment.current
    const scroller = calendarScrollRef.current
    if (pending && scroller) {
      const addedWidth = scroller.scrollWidth - pending.scrollWidth
      scroller.scrollLeft = pending.mode === 'start' ? 0 : pending.scrollLeft + addedWidth
      pendingTimelineAdjustment.current = null
    }
    if (pendingCalendarScrollRestore.current !== null && scroller) {
      scroller.scrollLeft = pendingCalendarScrollRestore.current
      pendingCalendarScrollRestore.current = null
    }
    isLoadingTimeline.current = false
  }, [dates, items])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)')
    const updateMobile = () => setIsMobile(media.matches)
    media.addEventListener('change', updateMobile)
    return () => media.removeEventListener('change', updateMobile)
  }, [])

  useEffect(() => {
    if (activeView !== 'week') return
    if (preservePlannerDateOnOpen.current) {
      preservePlannerDateOnOpen.current = false
      return
    }
    goToToday()
  }, [activeView, goToToday])

  useEffect(() => { localStorage.setItem(TASKS_KEY, JSON.stringify(items)) }, [items])
  useEffect(() => { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)) }, [notes])
  useEffect(() => { localStorage.setItem(XP_KEY, JSON.stringify(xp)) }, [xp])
  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) }, [history])
  useEffect(() => { localStorage.setItem(LOGBOOK_KEY, JSON.stringify(logbook)) }, [logbook])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = new Date()
      const todayKey = dateKey(now)
      if (lastTodayKey.current !== todayKey) {
        const previousTodayKey = lastTodayKey.current
        lastTodayKey.current = todayKey
        setItems((previous) => returnOverdueTasks(previous, todayKey))
        if (dateKey(weekStart) === previousTodayKey) {
          setWeekStart(startOfDay(now))
          setTimelineBefore(0)
          setTimelineAfter(0)
          pendingTimelineAdjustment.current = null
          isLoadingTimeline.current = false
        }
        setMobileDay((previousDay) => previousDay === previousTodayKey ? todayKey : previousDay)
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [weekStart])
  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target
      const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && undoItems) {
        event.preventDefault()
        setItems(undoItems)
        setUndoItems(null)
        setToast('Last schedule change undone')
      } else if (!typing && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setActiveView('notes')
        window.setTimeout(() => captureRef.current?.focus(), 20)
      } else if (event.key === 'Escape') {
        setEditing(null)
        setConversion(null)
        setArchiveOpen(false)
        setEditingCaptureId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undoItems])

  function notify(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2800)
  }

  function exportBackup() {
    try {
      const savedLogbook = localStorage.getItem(LOGBOOK_KEY)
      const logbook = savedLogbook ? JSON.parse(savedLogbook) : []
      const backup = createBackup(items, logbook)
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `elemental-backup-${dateKey(new Date())}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setBackupError('')
      notify('Tasks and invoices exported')
    } catch (error) {
      setBackupError(error instanceof Error ? `Backup export failed: ${error.message}` : 'Backup export failed.')
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const backup = parseBackup(await file.text())
      const confirmed = window.confirm(
        `Import ${backup.tasks.length} tasks and ${backup.logbook.length} invoices/expenses? This replaces the current tasks and invoice/expense records.`,
      )
      if (!confirmed) return

      const importedTasks = returnOverdueTasks(normalizeItems(backup.tasks), dateKey(new Date()))
      const previousValues = [
        [TASKS_KEY, localStorage.getItem(TASKS_KEY)],
        [LOGBOOK_KEY, localStorage.getItem(LOGBOOK_KEY)],
      ]
      try {
        localStorage.setItem(TASKS_KEY, JSON.stringify(importedTasks))
        localStorage.setItem(LOGBOOK_KEY, JSON.stringify(backup.logbook))
      } catch (error) {
        const restoreErrors = []
        previousValues.forEach(([key, value]) => {
          try {
            if (value === null) localStorage.removeItem(key)
            else localStorage.setItem(key, value)
          } catch (restoreError) {
            restoreErrors.push(restoreError)
          }
        })
        const details = restoreErrors.length ? ' Previous data could not be fully restored.' : ''
        throw new Error(`Browser storage could not save the backup.${details}`, { cause: error })
      }

      setItems(importedTasks)
      setLogbook(backup.logbook)
      setBackupError('')
      notify(`Imported ${backup.tasks.length} tasks and ${backup.logbook.length} invoices/expenses`)
    } catch (error) {
      setBackupError(error instanceof Error ? `Backup import failed: ${error.message}` : 'Backup import failed.')
    }
  }

  function updateItems(updater, undoable = false) {
    if (undoable) setUndoItems(items)
    setItems((previous) => typeof updater === 'function' ? updater(previous) : updater)
  }

  function placeItem(itemId, date, isMonthDrop = false, targetIndex = null) {
    const item = items.find((record) => record.id === itemId)
    if (!item) return
    const dayItems = items.filter((record) => record.id !== itemId && record.date === date)
    const insertAtStart = targetIndex === 0
    const order = insertAtStart ? 0 : Math.max(-1, ...dayItems.map((record) => record.order ?? -1)) + 1
    let next = recordScheduleChange(item, date, 'scheduled')
    next = { ...next, date, time: item.type === 'task' ? null : item.time ?? null, order, status: 'scheduled' }
    if (item.type === 'task' && item.frogDate && item.frogDate !== date) next = recordFrogChange(next, null, 'rescheduled')
    updateItems((previous) => previous.map((record) => {
      if (record.id === itemId) return next
      if (insertAtStart && record.date === date) return { ...record, order: (record.order ?? 0) + 1 }
      return record
    }), true)
    if (isMonthDrop) {
      const targetDate = new Date(`${date}T12:00:00`)
      showTimelineAt(targetDate)
    }
    notify('Added to the day')
  }

  function assignFrog(itemId, date, preserveExisting = false) {
    const item = items.find((record) => record.id === itemId)
    if (!item || item.type !== 'task') return false
    const existing = items.find((record) => record.id !== itemId && record.type === 'task' && record.frogDate === date && record.status !== 'completed')
    if (existing && !preserveExisting && !window.confirm(`${existing.title} is already the Daily Frog for ${new Date(`${date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}. Replace it?`)) {
      return false
    }
    const assignmentDate = date || item.frogDate
    pendingCalendarScrollRestore.current = calendarScrollRef.current?.scrollLeft ?? null
    updateItems((previous) => previous.map((record) => {
      if (record.id === itemId) {
        let scheduled = recordScheduleChange(record, assignmentDate, 'frog-assigned')
        scheduled = recordFrogChange(scheduled, assignmentDate, 'assigned')
        return { ...scheduled, date: assignmentDate, time: null, order: 0, status: record.status === 'completed' ? 'completed' : 'scheduled' }
      }
      if (record.id !== itemId && record.type === 'task' && record.frogDate === assignmentDate) {
        return recordFrogChange(record, null, 'replaced')
      }
      return record
    }), true)
    notify('Daily Frog updated')
    return true
  }

  function demoteFrogToTask(itemId, date) {
    const item = items.find((record) => record.id === itemId)
    if (!item || item.type !== 'task' || item.frogDate !== date) return
    const order = Math.max(-1, ...items
      .filter((record) => record.id !== itemId && record.date === date && record.type === 'task' && record.frogDate !== date)
      .map((record) => record.order ?? -1)) + 1
    pendingCalendarScrollRestore.current = calendarScrollRef.current?.scrollLeft ?? null
    updateItems((previous) => previous.map((record) => record.id === itemId
      ? { ...recordFrogChange(record, null, 'demoted-to-task'), date, time: null, order, status: 'scheduled' }
      : record), true)
    notify('Daily Frog moved to tasks')
  }

  function reorderInDay(itemId, targetId, targetDate) {
    if (itemId === targetId) return
    const activeItem = items.find((item) => item.id === itemId)
    const targetItem = items.find((item) => item.id === targetId)
    if (!activeItem || !targetItem?.date) return
    const date = targetDate || targetItem.date
    const dayItems = items.filter((item) => item.date === date ||
      (isFixedEvent(item) && item.endDate > item.date && item.date < date && item.endDate >= date),
    ).sort((left, right) => (left.order || 0) - (right.order || 0))
    const withoutActive = dayItems.filter((item) => item.id !== itemId)
    const targetIndex = withoutActive.findIndex((item) => item.id === targetId)
    const movedItem = { ...recordScheduleChange(activeItem, date, 'rescheduled'), date, time: null, status: 'scheduled' }
    withoutActive.splice(targetIndex < 0 ? withoutActive.length : targetIndex, 0, movedItem)
    const orderById = new Map(withoutActive.map((item, index) => [item.id, index]))
    updateItems((previous) => previous.map((item) => {
      if (!orderById.has(item.id)) return item
      if (isFixedEvent(item)) return { ...item, order: orderById.get(item.id) }
      let updated = recordScheduleChange(item, date, 'rescheduled')
      if (item.type === 'task' && item.frogDate && item.frogDate !== date) updated = recordFrogChange(updated, null, 'rescheduled')
      return { ...updated, date, time: null, order: orderById.get(item.id), status: 'scheduled' }
    }), true)
    notify('Day order updated')
  }

  function returnToQuestDeck(itemId) {
    updateItems((previous) => previous.map((record) => {
      if (record.id !== itemId || record.type !== 'task') return record
      let updated = recordScheduleChange(record, null, 'returned-to-quest-deck')
      updated = recordFrogChange(updated, null, 'returned-to-quest-deck')
      return { ...updated, date: null, time: null, status: 'ready', order: 0 }
    }), true)
    notify('Moved back to task deck')
  }

  function handleDragEnd(event) {
    stopDragAutoScroll()
    setDraggedItem(null)
    setDraggedItemWidth(null)
    const itemId = event.active.data.current?.itemId
    const target = event.over?.data.current
    if (!itemId || !target) return
    const draggedItem = items.find((record) => record.id === itemId)
    if (draggedItem && isFixedEvent(draggedItem)) return
    if (draggedItem?.frogDate && target.kind === 'item') {
      const targetItem = items.find((record) => record.id === target.itemId)
      if (targetItem?.date === draggedItem.frogDate && targetItem.frogDate !== draggedItem.frogDate) {
        demoteFrogToTask(itemId, draggedItem.frogDate)
        return
      }
    }
    if (target.kind === 'pool') {
      if (draggedItem?.type === 'task') returnToQuestDeck(itemId)
    } else if (target.kind === 'frog') {
      assignFrog(itemId, target.date)
    } else if (target.kind === 'regular-task') {
      if (draggedItem?.frogDate === target.date) demoteFrogToTask(itemId, target.date)
      else placeItem(itemId, target.date, false, target.index)
    } else if (target.kind === 'day' || target.kind === 'month') {
      placeItem(itemId, target.date, target.kind === 'month')
    } else if (target.kind === 'item') {
      reorderInDay(itemId, target.itemId, target.date)
    }
  }

  function handleDragStart(event) {
    const itemId = event.active.data.current?.itemId
    setDraggedItem(items.find((item) => item.id === itemId) || null)
    setDraggedItemWidth(event.active.rect.current.initial?.width || null)
  }

  function handleDragCancel() {
    stopDragAutoScroll()
    setDraggedItem(null)
    setDraggedItemWidth(null)
  }

  function createItem(title = '') {
    setEditing({ id: null, title, type: 'task', category: 'client-work', priority: 'Normal', project: '', duration: 60, date: null, endDate: null, time: null, order: 0, status: 'ready', dueDate: '', location: '' })
  }

  function openTaskEditor(event) {
    event.preventDefault()
    createItem(taskDraft.trim())
  }

  function saveEdit(draft) {
    const current = editing
    if (!current) {
      notify('This item is no longer available to edit')
      return
    }
    const title = typeof draft.title === 'string' ? draft.title.trim() : ''
    if (!title) {
      notify('Enter a task or event title')
      return
    }
    const duration = Math.max(30, Number(draft.duration) || 60)
    const scheduleDate = typeof draft.date === 'string' ? draft.date : ''
    const scheduleEndDate = typeof draft.endDate === 'string' ? draft.endDate : ''
    const scheduleTime = typeof draft.time === 'string' && draft.time ? draft.time : null
    const itemType = scheduleDate && scheduleTime ? 'event' : 'task'
    if (scheduleTime && !scheduleDate) {
      notify('Add a start date for a fixed event')
      return
    }
    if (scheduleEndDate && itemType !== 'event') {
      notify('Only fixed events can have an end date')
      return
    }
    if (scheduleEndDate && scheduleEndDate < scheduleDate) {
      notify('The end date must be on or after the start date')
      return
    }
    const dayItems = items.filter((item) => item.date === scheduleDate && item.id !== current.id)
    const order = scheduleDate ? current.date === scheduleDate ? current.order ?? 0 : Math.max(-1, ...dayItems.map((item) => item.order ?? -1)) + 1 : 0
    let record = {
      ...recordScheduleChange(current, scheduleDate || null, 'edited'),
      id: current.id || crypto.randomUUID(),
      title,
      type: itemType,
      category: categories[draft.category] ? draft.category : categories[current.category] ? current.category : 'personal-life',
      priority: priorities.includes(draft.priority) ? draft.priority : current.priority,
      project: typeof draft.project === 'string' ? draft.project.trim() : '',
      duration,
      date: scheduleDate || null,
      endDate: itemType === 'event' ? scheduleEndDate || null : null,
      time: itemType === 'event' ? scheduleTime : null,
      order,
      dueDate: itemType === 'task' && typeof draft.dueDate === 'string' ? draft.dueDate : '',
      status: current.status === 'completed' ? 'completed' : scheduleDate ? 'scheduled' : current.status === 'scheduled' ? 'ready' : current.status || 'ready',
      location: itemType === 'event' && typeof draft.location === 'string' ? draft.location.trim() : '',
      description: typeof draft.description === 'string' ? draft.description.trim() : '',
      frogDate: itemType === 'task' ? current.frogDate ?? null : null,
      xpAwarded: Boolean(current.xpAwarded),
    }
    if (itemType === 'task' && current.frogDate && current.frogDate !== scheduleDate) {
      record = recordFrogChange(record, null, 'rescheduled')
    } else if (itemType === 'task') {
      record = { ...record, frogDate: current.frogDate ?? null }
    }
    if (current.id) updateItems((previous) => previous.map((item) => item.id === current.id ? record : item), true)
    else updateItems((previous) => [record, ...previous])
    setEditing(null)
    if (!current.id) {
      if (taskDraft.trim() === title) setTaskDraft('')
      setActiveView('week')
      if (itemType === 'event') {
        showTimelineAt(new Date(`${scheduleDate}T12:00:00`))
      } else if (scheduleDate) {
        showTimelineAt(new Date(`${scheduleDate}T12:00:00`))
      } else {
        setActiveTab('ready')
        setPoolOpen(true)
      }
    }
  }

  function toggleComplete(itemId) {
    updateItems((previous) => {
      const target = previous.find((item) => item.id === itemId)
      if (!target) return previous
      const isCompleting = target.status !== 'completed'
      const nextState = previous.map((item) => {
        if (item.id !== itemId) return item
        const nextItem = { ...item, status: item.status === 'completed' ? item.date ? 'scheduled' : 'ready' : 'completed' }
        if (isCompleting && item.type === 'task' && item.frogDate && !item.xpAwarded) {
          const reward = Math.max(FROG_REWARD_XP, Math.round((item.duration || 60) / 15) * 5)
          setXp((currentXp) => currentXp + reward)
          setHistory((previousHistory) => [{ id: crypto.randomUUID(), title: item.title, date: item.frogDate, xp: reward, completedAt: new Date().toISOString() }, ...previousHistory])
          return { ...nextItem, xpAwarded: true }
        }
        return nextItem
      })
      return nextState
    })
  }

  function deleteItem(itemId) {
    if (window.confirm('Delete this item?')) updateItems((previous) => previous.filter((item) => item.id !== itemId))
  }

  function suggestDay() {
    const target = items.find((item) => item.status !== 'completed' && item.type === 'task' && !item.date)
    if (!target) return notify('Your task pool is clear')
    const availableDays = dates.map(dateKey).filter((day) => day >= dateKey(clock) && (!target.dueDate || day <= target.dueDate))
    const suggested = availableDays.sort((left, right) => items.filter((item) => item.date === left && item.status !== 'completed').length - items.filter((item) => item.date === right && item.status !== 'completed').length)[0]
    if (suggested) placeItem(target.id, suggested)
    else notify('No day before this task’s due date')
  }

  function addNote(event) {
    event.preventDefault()
    const text = captureDraft.trim()
    if (!text) return
    setNotes((previous) => [{ id: crypto.randomUUID(), text, pinned: false, archived: false, updatedAt: Date.now() }, ...previous])
    setCaptureDraft('')
  }

  function updateNote(noteId, changes) {
    setNotes((previous) => previous.map((note) => note.id === noteId ? { ...note, ...changes, updatedAt: Date.now() } : note))
  }

  function editCapture(note) {
    setEditingCaptureId(note.id)
    setArchiveDraft(note.text)
  }

  function saveCaptureEdit(noteId) {
    const text = archiveDraft.trim()
    if (!text) return
    updateNote(noteId, { text })
    setEditingCaptureId(null)
    setArchiveDraft('')
  }

  function deleteCapture(noteId) {
    setNotes((previous) => previous.filter((note) => note.id !== noteId))
    if (editingCaptureId === noteId) {
      setEditingCaptureId(null)
      setArchiveDraft('')
    }
  }

  function convertNote(note, lines) {
    const titles = lines.map((line) => line.trim()).filter(Boolean)
    if (!titles.length) return
    updateItems((previous) => [...titles.map((title) => ({ id: crypto.randomUUID(), title, type: 'task', category: 'client-work', priority: 'Normal', project: '', duration: 60, date: null, time: null, order: 0, status: 'ready', sourceNoteId: note.id, frogDate: null, xpAwarded: false })), ...previous])
    setConversion(null)
    setActiveView('week')
    setActiveTab('ready')
    notify(`${titles.length} ${titles.length === 1 ? 'task' : 'tasks'} added; original note kept`)
  }

  const activeItems = items.filter((item) => item.status !== 'completed')
  const poolItems = activeItems.filter((item) => item.type === 'task' && !item.date && (activeTab === 'inbox' ? item.status === 'inbox' : activeTab === 'ready' ? item.status !== 'inbox' : false))
  const scheduledCount = activeItems.filter((item) => item.date).length
  const completedCount = items.filter((item) => item.status === 'completed').length
  const visibleNotes = notes.filter((note) => Boolean(note.archived) === showArchived).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  const clockParts = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(clock)
  const clockHour = clockParts.find((part) => part.type === 'hour')?.value || '00'
  const clockMinute = clockParts.find((part) => part.type === 'minute')?.value || '00'
  const clockSecond = clockParts.find((part) => part.type === 'second')?.value || '00'
  const weekday = clock.toLocaleDateString([], { weekday: 'short' }).replace('.', '').toUpperCase()
  const month = clock.toLocaleDateString([], { month: 'short' }).replace('.', '').toUpperCase()

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={plannerCollisionDetection}
      autoScroll={false}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={`app-shell ${focusMode ? 'focus-mode' : ''} ${isDraggingToDeck ? 'dragging-to-deck' : ''}`}>
        <main className="main-area">
          <header className="topbar">
            <div className="topbar-brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><span>elemental</span></div>
            <nav className="top-navigation" aria-label="Main navigation">
              <button className={activeView === 'week' ? 'active' : ''} aria-current={activeView === 'week' ? 'page' : undefined} onClick={() => {
                if (activeView === 'week') goToToday()
                else setActiveView('week')
              }}>Planner</button>
              <button className={activeView === 'month' ? 'active' : ''} aria-current={activeView === 'month' ? 'page' : undefined} onClick={() => setActiveView('month')}>Month</button>
              <button className={activeView === 'notes' ? 'active' : ''} aria-current={activeView === 'notes' ? 'page' : undefined} onClick={() => setActiveView('notes')}>Ideas Inbox</button>
              <button className={activeView === 'logbook' ? 'active' : ''} aria-current={activeView === 'logbook' ? 'page' : undefined} onClick={() => setActiveView('logbook')}>Logbook</button>
            </nav>
            <div className="topbar-actions">
              <button className="quick-capture-top" aria-label="Quick capture" onClick={() => { setActiveView('notes'); window.setTimeout(() => captureRef.current?.focus(), 20) }}><Plus size={15} /><span>Quick capture</span><kbd>N</kbd></button>
              <span className="saved-indicator"><span /> All changes saved</span>
              <span className="xp-pill" title={`${xp} XP earned`}>XP {xp}</span>
              <CloudAccount
                user={user}
                loading={authLoading}
                configured={configured}
                authError={authError}
                syncStatus={syncStatus}
                syncError={syncError}
                onSignIn={signIn}
                onSignOut={signOut}
                onDismissError={() => { clearAuthError(); clearSyncError() }}
              />
              <button className={`icon-button ${focusMode ? 'selected' : ''}`} title="Focus mode" aria-label="Toggle focus mode" onClick={() => setFocusMode((value) => !value)}><Focus size={17} /></button>
            </div>
          </header>

          <section className={`workspace ${activeView === 'week' ? 'week-workspace' : ''}`}>
            {activeView === 'week' && <>
              <div className={`planner-layout ${isMobile && poolOpen ? 'pool-open-mobile' : ''}`}>
                <section className="planner-clock" aria-label="Clock and next event">
                  <div className="clock-caption"><span className="clock-signal" /> STUDIO / LOCAL TIME <span className="clock-index">INSTRUMENT 01</span></div>
                  <time className="clock-display" dateTime={clock.toISOString()} aria-label={clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}>
                    <span className="clock-main-time"><span>{clockHour}</span><span className="clock-separator">:</span><span>{clockMinute}</span></span>
                    <span className="clock-seconds">{clockSecond}</span>
                  </time>
                  <div
                    className="clock-minute-track"
                    role="progressbar"
                    aria-label="Current minute progress"
                    aria-valuemin={0}
                    aria-valuemax={59}
                    aria-valuenow={clock.getSeconds()}
                    style={{ '--minute-progress': `${clock.getSeconds() / 60}` }}
                  ><span /></div>
                  <div className="clock-date"><strong>{weekday}</strong><span>/</span><strong>{String(clock.getDate()).padStart(2, '0')} {month}</strong></div>
                  <div className="next-event">
                    <span className="next-event-label">NEXT FIXED EVENT</span>
                    {nextEvent
                      ? <><strong>{nextEvent.item.title}</strong><span>{nextEvent.startsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {nextEvent.startsAt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span></>
                      : <span className="no-next-event">NO UPCOMING COMMITMENT</span>}
                  </div>
                </section>
                <button
                  className="memory-spotlight capture-log"
                  type="button"
                  aria-label={`Open Archive. ${activeCaptures.length} active captures${logCapture ? `. Current capture: ${logCapture.text}` : ''}`}
                  onClick={() => setArchiveOpen(true)}
                  onPointerEnter={() => setLogHovered(true)}
                  onPointerLeave={() => setLogHovered(false)}
                  onFocus={() => setLogFocused(true)}
                  onBlur={() => setLogFocused(false)}
                >
                  <span className="log-heading">
                    <span className="spotlight-title"><span className="spotlight-track" aria-hidden="true"><span /></span><strong>LOG</strong><span>{activeCaptures.length ? `${String(activeCaptureIndex + 1).padStart(2, '0')} / ${String(activeCaptures.length).padStart(2, '0')}` : 'NO ACTIVE CAPTURES'}</span></span>
                    <span className="log-open-label"><Archive size={13} /> OPEN ARCHIVE</span>
                  </span>
                  <span className="log-entry">
                    {logCapture
                      ? <><span className="log-entry-meta">QUICK CAPTURE · {new Date(logCapture.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span className="log-entry-text">{logCapture.text}</span></>
                      : <><span className="log-entry-meta">QUICK CAPTURE</span><span className="log-entry-empty">Nothing captured yet. Quick captures will surface here.</span></>}
                  </span>
                </button>
                <section className="calendar-panel" aria-label="Scrollable planner timeline">
                  <div className="calendar-toolbar">
                    <div className="week-switcher"><button className="today-button" onClick={goToToday}>Today</button><button aria-label="Browse earlier dates" title="Earlier dates" onClick={() => navigateTimeline(-1)}><ChevronLeft size={17} /></button><button aria-label="Browse later dates" title="Later dates" onClick={() => navigateTimeline(1)}><ChevronRight size={17} /></button><strong>{formatRange(dates[0], weekEnd)}</strong></div>
                    <div className="calendar-actions"><button className="primary-button new-item-button" onClick={createItem}><Plus size={14} /> New Task or Event</button><button className="icon-button suggest-button" title="Suggest a light day for the next task" aria-label="Suggest a day" onClick={suggestDay}><Sparkles size={16} /></button><button className="view-switch active" onClick={() => setActiveView('week')}>Timeline</button><button className="view-switch" onClick={() => { setMonthDate(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1)); setActiveView('month') }}>Month</button><button className="icon-button pool-toggle" title={poolOpen ? 'Collapse task pool' : 'Show task pool'} aria-label="Toggle task pool" onClick={() => setPoolOpen((value) => !value)}><ListTodo size={17} /></button></div>
                  </div>
                  <div className="mobile-day-stepper"><button aria-label="Previous day" onClick={() => shiftMobileDay(-1)}><ChevronLeft size={16} /></button><strong>{new Date(`${mobileDay}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</strong><button aria-label="Next day" onClick={() => shiftMobileDay(1)}><ChevronRight size={16} /></button></div>
                  <div className="calendar-scroll" ref={calendarScrollRef} onScroll={extendTimeline}>
                    <div className="calendar-grid">
                      {dates.map((day) => {
                        const key = dateKey(day)
                        const taxDeadline = getBizkaiaTaxDeadline(day)
                        const spanningEvents = isMobile && key === mobileDay ? items.filter((item) =>
                          isFixedEvent(item) && item.endDate > item.date && item.date <= key && item.endDate >= key,
                        ) : []
                        const scheduledItems = items.filter((item) =>
                          item.date === key && !(isFixedEvent(item) && item.endDate > item.date),
                        )
                        const frog = getFrogForDate(items, key, true)
                        const dayItems = [...scheduledItems, ...spanningEvents]
                          .filter((item) => item.id !== frog?.id)
                          .sort((left, right) => (left.order || 0) - (right.order || 0) ||
                            (left.time || '').localeCompare(right.time || ''))
                        const dayIndex = dates.findIndex((date) => dateKey(date) === key)
                        const laneCount = Math.max(0, ...multiDayEventSegments
                          .filter((segment) => segment.startIndex <= dayIndex && segment.endIndex > dayIndex)
                          .map((segment) => segment.lane + 1))
                        const needsLeadSlot = dayItems.length === 0 && multiDayEventSegments.some((segment) =>
                          segment.hasLeadingItem && segment.startIndex <= dayIndex && segment.endIndex > dayIndex,
                        )
                        return <DropZone key={key} id={`day-${key}`} data={{ kind: 'day', date: key }} className={`day-column ${day.getDay() === 0 || day.getDay() === 6 ? 'is-weekend' : ''} ${key === currentDayKey ? 'is-today' : ''} ${key === mobileDay ? 'mobile-active' : ''}`} dateKeyValue={key}>
                          <div className="day-head">
                            <span>{day.toLocaleDateString([], { weekday: 'short' })}</span>
                            <strong>{day.getDate()}</strong>
                            <span className="day-count">{dayItems.length}</span>
                          </div>
                          <DropZone id={`frog-${key}`} data={{ kind: 'frog', date: key }} className={`frog-slot ${frog ? 'has-frog' : ''}`}>
                            {frog
                              ? <ItemCard item={frog} onEdit={setEditing} onToggleComplete={toggleComplete} onDelete={deleteItem} dropTarget={false} />
                              : <svg className="empty-frog-mark" viewBox="0 0 64 48" role="img" aria-label="Empty Daily Frog drop zone" xmlns="http://www.w3.org/2000/svg">
                                <path d="M15 25c0-7 7-12 17-12s17 5 17 12c0 7-7 12-17 12s-17-5-17-12Zm4-9-5-7m31 7 5-7M20 33l-7 7m31-7 7 7M23 13c-1-5 1-8 5-8s6 3 5 8m0 0c-1-5 1-8 5-8s6 3 5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 4" />
                                <circle cx="27" cy="18" r="1.5" fill="currentColor" />
                                <circle cx="37" cy="18" r="1.5" fill="currentColor" />
                              </svg>}
                          </DropZone>
                          <DropZone id={`tasks-${key}`} data={{ kind: 'regular-task', date: key, index: 0 }} className="day-task-list">
                            {dayItems.slice(0, 1).map((item) => <ItemCard key={item.id} item={item} onEdit={setEditing} onToggleComplete={toggleComplete} onDelete={deleteItem} dropDate={key} />)}
                            {!isMobile && (() => {
                              return <>
                                {needsLeadSlot && <div aria-hidden="true" className="multi-day-event-lead-spacer" />}
                                {Array.from({ length: laneCount }, (_, lane) => (
                                  <div key={lane} aria-hidden="true" className="multi-day-event-spacer" />
                                ))}
                              </>
                            })()}
                            {dayItems.slice(1).map((item) => <ItemCard key={item.id} item={item} onEdit={setEditing} onToggleComplete={toggleComplete} onDelete={deleteItem} dropDate={key} />)}
                          </DropZone>
                          {taxDeadline && <TaxDeadlineCard deadline={taxDeadline} />}
                        </DropZone>
                      })}
                      {!isMobile && multiDayEventSegments.map((segment) => <MultiDayEventCard key={`${segment.item.id}-${segment.startIndex}`} segment={segment} onEdit={setEditing} />)}
                    </div>
                  </div>
                  <div className="calendar-footnote"><span className="event-legend"><CalendarDays size={13} /> Fixed event</span><span className="task-legend"><Circle size={9} /> Flexible task</span><span className="working-hours">Scroll sideways to browse dates · Drag to reorder</span></div>
                </section>
                {(!isMobile || poolOpen) && <DropZone id="task-pool" data={{ kind: 'pool' }} className="task-pool">
                  <div className="pool-header"><div><div className="pool-title"><Inbox size={17} /><h2>Quest deck</h2><span className="pool-badge">{activeItems.filter((item) => item.type === 'task' && !item.date).length}</span></div><p>Ready when you are.</p></div><button className="icon-button" title="Collapse task deck" aria-label="Collapse task deck" onClick={() => setPoolOpen(false)}><ChevronRight size={17} /></button></div>
                  <form className="task-add-form" onSubmit={openTaskEditor}><Plus size={16} /><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="Add a task..." aria-label="New task title"/><button type="submit" aria-label="Add task details"><kbd>↵</kbd></button></form>
                  <div className="pool-tabs" role="tablist"><button className={activeTab === 'inbox' ? 'active' : ''} onClick={() => setActiveTab('inbox')}>Inbox <span>{activeItems.filter((item) => item.type === 'task' && item.status === 'inbox' && !item.date).length}</span></button><button className={activeTab === 'ready' ? 'active' : ''} onClick={() => setActiveTab('ready')}>Ready <span>{activeItems.filter((item) => item.type === 'task' && item.status === 'ready' && !item.date).length}</span></button><button className={activeTab === 'scheduled' ? 'active' : ''} onClick={() => setActiveTab('scheduled')}>Planned <span>{scheduledCount}</span></button><button className={activeTab === 'completed' ? 'active' : ''} onClick={() => setActiveTab('completed')}>Done <span>{completedCount}</span></button></div>
                  <div className="pool-list">
                    {activeTab === 'scheduled'
                      ? items.filter((item) => item.date && item.status !== 'completed').map((item) => {
                        const category = categories[item.category] || categories['personal-life']
                        return <div className="scheduled-pool-row" key={item.id}>
                          {item.type === 'task' && <CompletionCheckbox item={item} onToggleComplete={toggleComplete} />}
                          <span className={`tiny-element category-${item.category}`} title={category.label}><CategoryMark category={item.category} size={14} /></span>
                          <button className="scheduled-pool-title" onClick={() => setEditing(item)}>
                            {item.title}
                            <span>
                              {new Date(`${item.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                              {item.type === 'event' && item.time ? ` · ${item.time} · Fixed event` : ' · Flexible task'}
                              {' · '}{category.label}
                            </span>
                          </button>
                          {item.type === 'task' && <button className="icon-button" title="Unschedule" aria-label={`Unschedule ${item.title}`} onClick={() => returnToQuestDeck(item.id)}><ArrowDownUp size={14} /></button>}
                        </div>
                      })
                      : activeTab === 'completed'
                        ? items.filter((item) => item.status === 'completed').map((item) => {
                          const category = categories[item.category] || categories['personal-life']
                          return <div className="completed-row" key={item.id}>
                            <CompletionCheckbox item={item} onToggleComplete={toggleComplete} />
                            <span className={`completed-category category-${item.category}`}><CategoryMark category={item.category} size={13} /> {category.label}</span>
                            <span className="completed-title">{item.title}</span>
                          </div>
                        })
                        : poolItems.length
                          ? poolItems.map((item) => <ItemCard key={item.id} item={item} onEdit={setEditing} onToggleComplete={toggleComplete} onDelete={deleteItem} />)
                          : <div className="pool-empty"><div className="empty-icon"><CheckCheck size={21} /></div><strong>{activeTab === 'inbox' ? 'Inbox is clear' : 'You have room to choose'}</strong><span>{activeTab === 'inbox' ? 'Drop unfinished thoughts here.' : 'Add a task above or capture an idea.'}</span></div>}
                  </div>
                  <div className="pool-footer">
                    <button onClick={suggestDay}><Sparkles size={14} /> Suggest a lighter day</button>
                    <span>Nothing moves unless you choose</span>
                    <div className="backup-actions">
                      <button type="button" onClick={exportBackup} title="Download tasks and invoices as a JSON backup"><Download size={13} /> EXPORT BACKUP</button>
                      <button type="button" onClick={() => backupInputRef.current?.click()} title="Restore tasks and invoices from a JSON backup"><Upload size={13} /> IMPORT BACKUP</button>
                      <input ref={backupInputRef} type="file" accept=".json,application/json" aria-label="Select Elemental backup file" onChange={importBackup} />
                    </div>
                    {backupError && <p className="backup-error" role="alert">{backupError}</p>}
                    <span className="backup-help">JSON backup includes tasks, invoices, expenses &amp; attachments.</span>
                  </div>
                </DropZone>}
              </div>
            </>}

            {activeView === 'month' && <>
              <div className="page-heading month-heading"><div><div className="eyebrow"><span className="eyebrow-mark"><span /><span /><span /><span /></span> A WIDER VIEW</div><h1>Monthly rhythm.</h1><p className="heading-subtitle">See the shape of your commitments at a glance.</p></div><div className="heading-actions"><button className="primary-button" onClick={createItem}><Plus size={16} /> New Task or Event</button></div></div>
              <div className="month-toolbar"><div className="week-switcher"><button className="today-button" onClick={() => setMonthDate(new Date())}>Today</button><button aria-label="Previous month" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}><ChevronLeft size={17} /></button><button aria-label="Next month" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}><ChevronRight size={17} /></button><strong>{monthDate.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong></div><div className="month-stats"><span><i className="stat-dot event-dot" /> {activeItems.filter((item) => item.type === 'event').length} fixed events</span><span><i className="stat-dot task-dot" /> {activeItems.filter((item) => item.type === 'task' && item.date).length} planned tasks</span></div></div>
              <MonthGrid monthDate={monthDate} items={items.filter((item) => item.status !== 'completed')} onSelectDate={(day) => { preservePlannerDateOnOpen.current = true; showTimelineAt(day); setActiveView('week') }} onEdit={setEditing} onToggleComplete={toggleComplete} />
              <div className="month-hint"><span>◆ Fixed event</span><span>• Flexible task</span><span>Choose a date to open its week</span></div>
            </>}

            {activeView === 'notes' && <>
              <div className="page-heading notes-heading"><div><div className="eyebrow"><NotebookPen size={13} /> THOUGHTS, BEFORE THEY HAVE TO BE ANYTHING</div><h1>Ideas inbox.</h1><p className="heading-subtitle">Get it out of your head. Sort it out when you’re ready.</p></div><span className="notes-total">{notes.filter((note) => !note.archived).length} notes</span></div>
              <div className="notes-layout">
                <section className="capture-panel"><div className="capture-panel-heading"><span className="capture-symbol"><Sparkles size={16} /></span><div><strong>Scratchpad</strong><span>Unfiltered is welcome.</span></div><kbd><Command size={12} /> N</kbd></div><form onSubmit={addNote}><textarea ref={captureRef} value={captureDraft} onChange={(event) => setCaptureDraft(event.target.value)} placeholder="A thought, a reminder, a half-formed idea..." rows={4} aria-label="Capture a note"/><div className="capture-footer"><span>Only you can see these notes</span><button className="primary-button" type="submit" disabled={!captureDraft.trim()}><Plus size={15} /> Save thought</button></div></form></section>
                <div className="notes-list-toolbar"><strong>{showArchived ? 'Archived notes' : 'Ideas inbox'} <span>{visibleNotes.length}</span></strong><button className="text-button" onClick={() => setShowArchived((value) => !value)}><Archive size={14} /> {showArchived ? 'Show active' : 'Show archived'}</button></div>
                <section className="notes-list">{visibleNotes.map((note) => <article id={`note-${note.id}`} className={`note-card ${note.pinned ? 'pinned' : ''}`} key={note.id}><div className="note-card-head"><span className="note-date">{new Date(note.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {new Date(note.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><div className="note-tools"><button className={note.pinned ? 'active' : ''} title={note.pinned ? 'Unpin note' : 'Pin note'} aria-label={note.pinned ? 'Unpin note' : 'Pin note'} onClick={() => updateNote(note.id, { pinned: !note.pinned })}><Pin size={14} /></button><button title={note.archived ? 'Restore note' : 'Archive note'} aria-label={note.archived ? 'Restore note' : 'Archive note'} onClick={() => updateNote(note.id, { archived: !note.archived })}><Archive size={14} /></button><button title="Delete note" aria-label="Delete note" onClick={() => setNotes((previous) => previous.filter((record) => record.id !== note.id))}><Trash2 size={14} /></button></div></div><textarea value={note.text} aria-label="Edit note" onChange={(event) => updateNote(note.id, { text: event.target.value })} rows={Math.max(2, Math.min(6, note.text.split('\n').length + 1))}/><div className="note-card-footer"><span>{items.some((item) => item.sourceNoteId === note.id) ? 'Tasks linked' : 'Idea'}</span><button onClick={() => { setConversion({ note, text: note.text }); }}><ListTodo size={14} /> Turn into task</button></div></article>)}{visibleNotes.length === 0 && <div className="notes-empty"><div className="empty-icon"><NotebookPen size={21} /></div><strong>{showArchived ? 'Nothing archived yet.' : 'Your mind can be a little quieter now.'}</strong><span>{showArchived ? 'Archived thoughts will wait here.' : 'Drop the loose thoughts here; nothing gets scheduled until you choose.'}</span></div>}</section>
              </div>
            </>}

            {activeView === 'logbook' && <Logbook records={logbook} onRecordsChange={setLogbook} />}

          </section>
          <footer className="app-footer"><span><span className="footer-mark"><span /><span /><span /><span /></span> Make space. Find your element.</span><span className="footer-status"><span /> Local and private</span></footer>
        </main>
        {toast && <div className="toast-message"><Check size={15} /> {toast}</div>}
        {archiveOpen && <div className="modal-backdrop archive-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setArchiveOpen(false); setEditingCaptureId(null) } }}>
          <section className="edit-modal archive-modal" role="dialog" aria-modal="true" aria-labelledby="archive-title">
            <div className="modal-heading"><div><span className="eyebrow">ACTIVE QUICK CAPTURES</span><h2 id="archive-title">Archive.</h2></div><button type="button" className="icon-button" aria-label="Close Archive" onClick={() => { setArchiveOpen(false); setEditingCaptureId(null) }}><X size={18} /></button></div>
            <div className="archive-list">
              {activeCaptures.length
                ? activeCaptures.map((capture) => <article className="archive-entry" key={capture.id}>
                  <div className="archive-entry-meta"><span>CAPTURE</span><time>{new Date(capture.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</time></div>
                  {editingCaptureId === capture.id
                    ? <textarea autoFocus rows={Math.max(2, Math.min(6, archiveDraft.split('\n').length + 1))} aria-label="Edit quick capture" value={archiveDraft} onChange={(event) => setArchiveDraft(event.target.value)} />
                    : <p>{capture.text}</p>}
                  <div className="archive-entry-actions">
                    {editingCaptureId === capture.id
                      ? <><button type="button" className="secondary-button" onClick={() => { setEditingCaptureId(null); setArchiveDraft('') }}>Cancel</button><button type="button" className="primary-button" disabled={!archiveDraft.trim()} onClick={() => saveCaptureEdit(capture.id)}><Check size={14} /> Save</button></>
                      : <><button type="button" className="secondary-button" onClick={() => editCapture(capture)}><Pencil size={13} /> Edit</button><button type="button" className="delete-button" onClick={() => deleteCapture(capture.id)}><Trash2 size={13} /> Delete</button></>}
                  </div>
                </article>)
                : <div className="archive-empty"><Archive size={24} /><strong>Archive is clear.</strong><span>New Quick Captures will appear here.</span></div>}
            </div>
          </section>
        </div>}
        {editing && <TaskFormModal
          key={editing.id || 'new-item'}
          item={editing}
          onSave={saveEdit}
          onClose={() => setEditing(null)}
          onDelete={(itemId) => { deleteItem(itemId); setEditing(null) }}
        />}
        {conversion && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConversion(null) }}><form className="edit-modal conversion-modal" onSubmit={(event) => { event.preventDefault(); convertNote(conversion.note, conversion.text.split('\n')) }}><div className="modal-heading"><div><span className="eyebrow">KEEPING THE ORIGINAL NOTE</span><h2>Make it actionable.</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setConversion(null)}><X size={18} /></button></div><p className="conversion-copy">Edit or split into separate lines. Each line becomes a task; the original stays in your inbox.</p><label>Tasks<textarea rows={6} value={conversion.text} onChange={(event) => setConversion((value) => ({ ...value, text: event.target.value }))} autoFocus /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConversion(null)}>Cancel</button><button className="primary-button" type="submit"><Plus size={15} /> Create tasks</button></div></form></div>}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null} zIndex={9999}>
          {draggedItem && <DragPreview item={draggedItem} width={draggedItemWidth} />}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}

export default App