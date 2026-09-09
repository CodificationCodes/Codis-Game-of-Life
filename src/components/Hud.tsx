import type { Stats } from '../render/engine';

interface Props {
  stats: Stats;
  zoom: number;
  hint: string | null;
}

export function Hud({ stats, zoom, hint }: Props) {
  return (
    <div className="hud">
      <div className="hud-row">
        <Metric label="People" value={stats.people} accent="#f2c14e" />
        <Metric label="Cars" value={stats.cars} accent="#4f7fd9" />
      </div>
      <div className="hud-sub">
        <span>{stats.fps} fps</span>
        <span>z{zoom.toFixed(1)}</span>
        <span>{stats.cells} cells</span>
        <span>{stats.roadEdges ? `${stats.roadEdges} road segs` : 'no road data'}</span>
      </div>
      {hint && <div className="hud-hint">{hint}</div>}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="metric">
      <span className="metric-dot" style={{ background: accent }} />
      <strong>{value.toLocaleString()}</strong>
      <span className="metric-label">{label}</span>
    </div>
  );
}
