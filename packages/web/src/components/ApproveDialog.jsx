function ApproveDialog({ approve, onRespond }) {
  if (!approve) return null

  return (
    <div className="approve-overlay">
      <div className="approve-dialog">
        <p className="approve-title">Tool approval required</p>
        <p className="approve-desc">{approve.description}</p>
        <div className="approve-actions">
          <button className="btn-approve" onClick={() => onRespond(true)}>Approve</button>
          <button className="btn-deny" onClick={() => onRespond(false)}>Deny</button>
        </div>
      </div>
    </div>
  )
}

export default ApproveDialog
