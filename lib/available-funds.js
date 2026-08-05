import clus from "../models/cluster_model.js";
import AuthorshipBlock from "../models/authorship_block_model.js";

// Balance no longer moves when a purchase is made (only when a profit is realized) — so
// "can this user afford this purchase" has to be checked against Balance minus whatever they've
// already committed to positions they still hold (unsold cells, blocks not yet paid out), not
// against the raw balance field alone.
export async function computeCommittedFunds(clerkId, session) {
  const clusters = await clus.find({ "cells.ownerClerkId": clerkId }, { cells: 1 }).session(session);
  let cellCommitted = 0;
  for (const cluster of clusters) {
    for (const cell of cluster.cells || []) {
      if (cell.ownerClerkId === clerkId) cellCommitted += Number(cell.acquiredPrice || 0);
    }
  }

  const openBlocks = await AuthorshipBlock.find({ ownerClerkId: clerkId, status: "sold" }).session(session);
  const blockCommitted = openBlocks.reduce((sum, block) => {
    const current = (block.ownershipHistory || []).find((entry) => !entry.releasedAt);
    return sum + Number(current?.price ?? 0);
  }, 0);

  return cellCommitted + blockCommitted;
}
