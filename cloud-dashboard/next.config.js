/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // `ws` (AppSync realtime subscription client, #259) breaks when webpack
  // bundles it for the API route — its internal frame-masking function ends
  // up undefined ("b.mask is not a function") after minification. Keeping it
  // external makes Next require() it straight from node_modules at runtime.
  serverExternalPackages: ["ws"],
};

module.exports = nextConfig;
