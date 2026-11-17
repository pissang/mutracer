export const AOV_BACKGROUND_ID = 0xffffffff;
let nextId = 0;
export function allocateAovId(): number {
  if (nextId >= AOV_BACKGROUND_ID) throw new RangeError('AOV ID space exhausted');
  return nextId++;
}
export function validateAovId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= AOV_BACKGROUND_ID) throw new RangeError('AOV ID must be uint32 excluding 0xFFFFFFFF');
  return value;
}
