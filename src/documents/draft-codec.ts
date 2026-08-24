function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeUtf16CodeUnitsBase64(value: string): string {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >>> 8;
  }
  return bytesToBase64(bytes);
}

export function decodeUtf16CodeUnitsBase64(value: string): string {
  const bytes = base64ToBytes(value);
  if (bytes.length % 2 !== 0) throw new Error("invalid UTF-16 draft payload");
  let result = "";
  const chunk = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunk * 2) {
    const codeUnits = new Uint16Array(Math.min(chunk * 2, bytes.length - offset) / 2);
    let output = 0;
    for (let index = offset; index < Math.min(bytes.length, offset + chunk * 2); index += 2) {
      codeUnits[output] = bytes[index] | (bytes[index + 1] << 8);
      output += 1;
    }
    result += String.fromCharCode(...codeUnits);
  }
  return result;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
