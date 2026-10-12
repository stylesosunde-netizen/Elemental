export function mergeCloudRecords(localRecords, snapshotRecords) {
  const merged = new Map(localRecords.map((record) => [record.id, record]))
  snapshotRecords.forEach(({ id, deleted, payload }) => {
    if (deleted) merged.delete(id)
    else merged.set(id, payload)
  })
  return [...merged.values()]
}

export function dataForAccount(ownerUid, userUid, localData, accountData) {
  if (!ownerUid || ownerUid === userUid) return localData
  return accountData || { tasks: [], notes: [], xp: 0, history: [], logbook: [] }
}
