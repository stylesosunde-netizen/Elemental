export function prioritizePlannerCollisions(collisions, droppableContainers) {
  const targetKind = (collision) => droppableContainers.find((container) => container.id === collision.id)?.data.current?.kind
  const preferred = collisions.find((collision) => targetKind(collision) === 'pool') ??
    collisions.find((collision) => targetKind(collision) === 'item') ??
    collisions.find((collision) => targetKind(collision) === 'regular-task')

  return preferred
    ? [preferred, ...collisions.filter((collision) => collision.id !== preferred.id)]
    : collisions
}
