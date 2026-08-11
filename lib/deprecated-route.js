// Handler factory for endpoints that used to mint/move balance with zero identity verification
// (the old mock deposit/fund/withdraw routes). Kept registered instead of deleted, so an old
// cached frontend build or a stray script hitting the path gets a clear, loud 410 — visible in
// logs — instead of a silent 404 that's easy to miss.
export function retiredEndpoint(useInstead) {
  return (req, res) => {
    console.warn(`[RETIRED ENDPOINT] ${req.method} ${req.originalUrl} called with body=${JSON.stringify(req.body)} from ip=${req.ip}`);
    return res.status(410).json({
      success: false,
      error: `This endpoint has been retired and no longer moves or creates balance. Use ${useInstead} instead.`,
      retiredAt: "2026-08-11",
    });
  };
}
