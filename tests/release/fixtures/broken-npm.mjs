// Stands in for `npm-cli.js` in the malformed-output test: exits 0 but does not print JSON,
// which is exactly the case a "generate and hope" script would pass through.
process.stdout.write("npm notice: this is not a document\n");
