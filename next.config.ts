import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) usa recursos específicos do Node (worker) que
  // não bundleiam bem — roda como require() nativo em vez de ser empacotado.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
