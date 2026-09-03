import type { PortfolioReview } from "../lib/operator-review";

export function OperatorReviewPanel({ review }: { review: PortfolioReview }) {
  const number = (value: number) => value.toLocaleString();
  return <div className="portfolio-review">
    <h3>Engine-verified portfolio</h3>
    <p>{review.evaluatedRequests} of {review.totalRequests} requests evaluated · Latest saved version: {review.latestSavedVersion ?? "None"}. No changes made.</p>
    {review.resources.map((resource) => <section key={resource.id} aria-label={`${resource.label} portfolio results`}>
      <h4>{resource.label} · {resource.unit}</h4>
      <dl className="portfolio-review-balances">
        <div><dt>Requested demand</dt><dd>{number(resource.requestedDemand)}</dd></div>
        <div><dt>Reserved</dt><dd>{number(resource.ledger.reserved)}</dd></div>
        <div><dt>Committed authorization</dt><dd>{number(resource.ledger.committed)}</dd></div>
        <div><dt>Recorded consumption</dt><dd>{number(resource.ledger.consumed)}</dd></div>
        <div><dt>Available balance</dt><dd>{number(resource.ledger.available)}</dd></div>
      </dl>
      <div className="portfolio-review-table" tabIndex={0} role="region" aria-label={`${resource.label} request results`}><table>
        <thead><tr><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Score</th><th scope="col">Rank</th><th scope="col">Requested</th><th scope="col">Simulated allocation</th><th scope="col">Additional authorizable</th></tr></thead>
        <tbody>{review.requests.map((request) => {
          const values = request.resources.find((item) => item.id === resource.id)!;
          return <tr key={request.id}><th scope="row">{request.name}<small>{request.id}</small></th><td>{request.outcome}</td><td>{number(request.score)}</td><td>{request.rank ?? "—"}</td><td>{number(values.requestedDemand)}</td><td>{number(values.simulatedAllocation)}</td><td>{number(values.additionalAuthorizable)}</td></tr>;
        })}</tbody>
      </table></div>
    </section>)}
    <p className="form-note">Demand is not usage. Simulations are not commitments. Additional authorizable amounts account for existing holds and proposals; this review does not authorize them. Zero recorded consumption does not mean zero provider usage.</p>
  </div>;
}
