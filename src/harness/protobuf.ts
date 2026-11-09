export type ProtoField = { field: number; wire: 0; value: bigint } | { field: number; wire: 2; bytes: Uint8Array }

function readVarint(bytes: Uint8Array, start: number): [bigint, number] | null {
  let result = 0n
  let shift = 0n
  let index = start
  while (index < bytes.length && shift < 70n) {
    const byte = bytes[index++] as number
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result, index]
    shift += 7n
  }
  return null
}

export function readProtoFields(bytes: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = []
  let index = 0
  while (index < bytes.length) {
    const tag = readVarint(bytes, index)
    if (!tag) return null
    index = tag[1]
    const field = Number(tag[0] >> 3n)
    const wire = Number(tag[0] & 7n)
    if (field === 0) return null
    if (wire === 0) {
      const value = readVarint(bytes, index)
      if (!value) return null
      index = value[1]
      fields.push({ field, wire, value: value[0] })
    } else if (wire === 1) index += 8
    else if (wire === 5) index += 4
    else if (wire === 2) {
      const length = readVarint(bytes, index)
      if (!length) return null
      index = length[1]
      const end = index + Number(length[0])
      if (end > bytes.length) return null
      fields.push({ field, wire, bytes: bytes.subarray(index, end) })
      index = end
    } else return null
    if (index > bytes.length) return null
  }
  return fields
}

export function protoMessage(bytes: Uint8Array, field: number): Uint8Array | null {
  const fields = readProtoFields(bytes)
  const found = fields?.find((candidate) => candidate.field === field && candidate.wire === 2)
  return found && found.wire === 2 ? found.bytes : null
}

export function protoString(bytes: Uint8Array, path: readonly number[]): string | null {
  let current: Uint8Array | null = bytes
  for (const field of path) {
    if (!current) return null
    current = protoMessage(current, field)
  }
  return current ? new TextDecoder('utf-8', { fatal: false }).decode(current) : null
}
