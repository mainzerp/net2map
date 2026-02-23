// ── FilterBar ────────────────────────────────────────────────────────────────
function FilterBar({ racks, classes, filters, onFilterChange }) {
  const toggleRack = (rackId) => {
    onFilterChange(prev => {
      const current = prev.racks ? new Set(prev.racks) : new Set(racks.map(r => r.id));
      if (current.has(rackId)) current.delete(rackId);
      else current.add(rackId);
      return { ...prev, racks: current.size === racks.length ? null : current.size === 0 ? new Set() : current };
    });
  };
  const toggleClass = (classId) => {
    onFilterChange(prev => {
      const current = prev.classes ? new Set(prev.classes) : new Set(classes.map(c => c.id));
      if (current.has(classId)) current.delete(classId);
      else current.add(classId);
      return { ...prev, classes: current.size === classes.length ? null : current.size === 0 ? new Set() : current };
    });
  };
  const clearFilters = () => onFilterChange({ racks: null, classes: null });
  const hasFilters = filters.racks !== null || filters.classes !== null;

  if (racks.length === 0 && classes.length === 0) return null;

  const btnStyle = (active) => ({
    fontSize: 10, padding: "3px 8px", borderRadius: 4, cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif", border: "1px solid",
    borderColor: active ? "#164e63" : "#1e293b",
    backgroundColor: active ? "#083344" : "#0a0e18",
    color: active ? "#22d3ee" : "#475569",
    transition: "all 0.15s", userSelect: "none",
  });

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, marginBottom: 10,
      padding: "8px 12px", backgroundColor: "#020817",
      border: "1px solid #0f172a", borderRadius: 8,
      fontFamily: "'Inter', system-ui, sans-serif", flexWrap: "wrap",
    }}>
      {racks.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "#334155", letterSpacing: 1 }}>RACKS</span>
          {racks.map(r => {
            const active = !filters.racks || filters.racks.has(r.id);
            return (
              <button key={r.id} onClick={() => toggleRack(r.id)} style={btnStyle(active)}>
                {r.label}
              </button>
            );
          })}
        </div>
      )}
      {classes.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "#334155", letterSpacing: 1 }}>CLASSES</span>
          {classes.map(c => {
            const active = !filters.classes || filters.classes.has(c.id);
            return (
              <button key={c.id} onClick={() => toggleClass(c.id)} style={{
                ...btnStyle(active),
                borderColor: active ? `${c.color}66` : "#1e293b",
                backgroundColor: active ? `${c.color}18` : "#0a0e18",
                color: active ? c.color : "#475569",
              }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                  backgroundColor: c.color, marginRight: 4, verticalAlign: "middle",
                  opacity: active ? 1 : 0.3,
                }}/>
                {c.label}
              </button>
            );
          })}
        </div>
      )}
      {hasFilters && (
        <button onClick={clearFilters} style={{
          fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer",
          fontFamily: "'Inter', system-ui, sans-serif",
          border: "1px solid #7f1d1d", backgroundColor: "transparent",
          color: "#f87171",
        }}>Clear filters</button>
      )}
    </div>
  );
}

export default FilterBar;
