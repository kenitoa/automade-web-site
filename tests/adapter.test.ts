import test from "node:test";
import assert from "node:assert/strict";
import {
  publicAddress,
  validateGenerationConfig,
} from "../server/generationAdapter";
test("generation provider cannot use private, mapped, reserved or link-local addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.2",
    "192.168.1.2",
    "172.31.1.1",
    "169.254.169.254",
    "100.64.1.2",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fd00::1",
  ])
    assert.equal(publicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(publicAddress(address), true, address);
});
test("generation configuration fails early for HTTP or host mismatch", () => {
  const previous = {
    url: process.env.GENERATION_API_URL,
    host: process.env.GENERATION_API_HOST,
    key: process.env.GENERATION_API_KEY,
  };
  try {
    delete process.env.GENERATION_API_KEY;
    process.env.GENERATION_API_URL = "http://example.org/generate";
    process.env.GENERATION_API_HOST = "example.org";
    assert.throws(validateGenerationConfig);
    process.env.GENERATION_API_URL = "https://example.org/generate";
    process.env.GENERATION_API_HOST = "evil.org";
    assert.throws(validateGenerationConfig);
    process.env.GENERATION_API_HOST = "example.org";
    assert.doesNotThrow(validateGenerationConfig);
  } finally {
    for (const [k, v] of [
      ["GENERATION_API_URL", previous.url],
      ["GENERATION_API_HOST", previous.host],
      ["GENERATION_API_KEY", previous.key],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
