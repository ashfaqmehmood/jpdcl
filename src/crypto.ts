import CryptoJS from "crypto-js";

const PASSPHRASE = "wertyuioplkjhgfdsazxcvbnmkiujnhy";
export const ENCRYPTED_FIELD = "khasgafsgauysuaysyuasyahghagsggadkdcnviw";

export function encryptPayload(payload: unknown): Record<string, string> {
  const iv = CryptoJS.lib.WordArray.random(16);
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(payload), PASSPHRASE, { iv });
  return { [ENCRYPTED_FIELD]: iv.toString(CryptoJS.enc.Base64) + ciphertext.toString() };
}
export function decryptPayload<T = unknown>(payload: string): T {
  if (!payload || payload.length < 25) {
    throw new Error("JPDCL returned an invalid encrypted response");
  }
  const iv = CryptoJS.enc.Base64.parse(payload.slice(0, 24));
  const ciphertext = payload.slice(24);
  const bytes = CryptoJS.AES.decrypt(ciphertext, PASSPHRASE, { iv });
  const plaintext = bytes.toString(CryptoJS.enc.Utf8);
  if (!plaintext) throw new Error("Unable to decrypt the JPDCL response");
  return JSON.parse(plaintext) as T;
}
