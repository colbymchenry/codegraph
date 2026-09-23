// Trusted publication policy only; never accept a policy record from a submission.
const repository = value => typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) && !value.endsWith('.git');
const sourcePath = value => typeof value === 'string' && value.length < 240 && /^[A-Za-z0-9_./-]+\.cgext$/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
function requireSourceReview(reviews, pkg, integrity, publisherId, claim) {
  if (!repository(claim?.source) || !/^[a-f0-9]{40}$/.test(claim?.sourceRevision || '') || !sourcePath(claim?.sourcePath)) throw Error('Source requires a public GitHub repository, full immutable commit SHA and committed .cgext path');
  const review = reviews.find(r => r.id === pkg.codegraph.id && r.version === pkg.version && r.integrity === integrity && r.publisherId === publisherId);
  if (!review || review.format !== 'codegraph-source-review-1' || review.repository !== claim.source || review.revision !== claim.sourceRevision || review.path !== claim.sourcePath || !Number.isFinite(Date.parse(review.checkedAt))) throw Error('This exact publisher/version/package needs an operator-reviewed public source snapshot before publication');
  return {format:review.format, repository:review.repository, revision:review.revision, path:review.path, integrity:review.integrity, checkedAt:review.checkedAt, verification:'public-committed-package-bytes'};
}
module.exports = {repository, sourcePath, requireSourceReview};
