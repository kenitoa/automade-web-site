import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { record, ValidationError } from "../src/domain/validation";
import { parseArtifactContract } from "../src/domain/artifactContracts";
export interface ArtifactSignature {
  algorithm: "Ed25519";
  signerId: string;
  keyId: string;
  contractSha256: string;
  signature: string;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const contractBytes = (value: unknown): Buffer =>
  Buffer.from(canonical(parseArtifactContract(value)));
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,100}$/.test(value))
    throw new ValidationError("결과물 서명자와 신뢰 키 ID를 확인하세요.");
  return value;
}
export function parseArtifactSignature(value: unknown): ArtifactSignature {
  const input = record(value);
  if (
    input.algorithm !== "Ed25519" ||
    typeof input.contractSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.contractSha256) ||
    typeof input.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)
  )
    throw new ValidationError("결과물 서명 형식을 확인하세요.");
  return {
    algorithm: "Ed25519",
    signerId: identifier(input.signerId),
    keyId: identifier(input.keyId),
    contractSha256: input.contractSha256,
    signature: input.signature,
  };
}
export function signArtifactContract(
  contract: unknown,
  privateKeyPem: string,
  signerId: string,
  keyId: string,
): ArtifactSignature {
  return signContract(
    contractBytes(contract),
    "automade.artifact.signature.v1",
    privateKeyPem,
    signerId,
    keyId,
  );
}
export function signDeploymentContract(
  contract: unknown,
  privateKeyPem: string,
  signerId: string,
  keyId: string,
): ArtifactSignature {
  return signContract(
    Buffer.from(canonical(record(contract))),
    "automade.deployment.signature.v1",
    privateKeyPem,
    signerId,
    keyId,
  );
}
function signContract(
  bytes: Buffer,
  format: string,
  privateKeyPem: string,
  signerId: string,
  keyId: string,
): ArtifactSignature {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Artifact signing requires an Ed25519 private key");
  const signer = identifier(signerId),
    id = identifier(keyId),
    payload = Buffer.from(
      canonical({
        format,
        signerId: signer,
        keyId: id,
        contract: JSON.parse(bytes.toString("utf8")),
      }),
    );
  return {
    algorithm: "Ed25519",
    signerId: signer,
    keyId: id,
    contractSha256: createHash("sha256").update(bytes).digest("hex"),
    signature: sign(null, payload, key).toString("base64"),
  };
}
export function verifyArtifactSignature(
  contract: unknown,
  input: unknown,
  trustedPublicKeyPem: string,
): boolean {
  return verifyContract(
    contractBytes(contract),
    "automade.artifact.signature.v1",
    input,
    trustedPublicKeyPem,
  );
}
export function verifyDeploymentSignature(
  contract: unknown,
  input: unknown,
  trustedPublicKeyPem: string,
): boolean {
  return verifyContract(
    Buffer.from(canonical(record(contract))),
    "automade.deployment.signature.v1",
    input,
    trustedPublicKeyPem,
  );
}
function verifyContract(
  bytes: Buffer,
  format: string,
  input: unknown,
  trustedPublicKeyPem: string,
): boolean {
  const signature = parseArtifactSignature(input),
    key = createPublicKey(trustedPublicKeyPem);
  const payload = Buffer.from(
    canonical({
      format,
      signerId: signature.signerId,
      keyId: signature.keyId,
      contract: JSON.parse(bytes.toString("utf8")),
    }),
  );
  return (
    key.asymmetricKeyType === "ed25519" &&
    signature.contractSha256 ===
      createHash("sha256").update(bytes).digest("hex") &&
    verify(null, payload, key, Buffer.from(signature.signature, "base64"))
  );
}
