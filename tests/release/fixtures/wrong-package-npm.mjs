// Stands in for `npm-cli.js` in the wrong-package test: a well-formed CycloneDX document that
// describes a different package. Accepting it would attach a real-looking SBOM to the wrong
// version, so `scripts/sbom.mjs` must reject it.
process.stdout.write(`${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
  metadata: { timestamp: "2030-01-01T00:00:00.000Z", component: { type: "library", name: "some-other-package", version: "9.9.9" } },
  components: [],
})}\n`);
