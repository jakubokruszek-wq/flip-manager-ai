// Next font loader fixture, using the Geist already shipped with Next.
module.exports = new Proxy({}, {
  get: (_target, key) => typeof key === "string" && key.startsWith("https://fonts.googleapis.com/")
    ? "/* latin */\n@font-face { font-family: 'Geist'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/offline-geist.woff2) format('woff2'); }"
    : undefined,
});
