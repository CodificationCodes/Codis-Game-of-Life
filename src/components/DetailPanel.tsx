import { mercToLngLat, metersPerMerc } from '../sim/geo';
import type { Agent } from '../sim/types';

interface Props {
  agent: Agent | null;
  collapsed: boolean;
  onToggle(): void;
  onClose(): void;
}

export function DetailPanel({ agent, collapsed, onToggle, onClose }: Props) {
  if (!agent) return null;

  const mPerMerc = metersPerMerc(agent.y);
  const totalM = agent.path.total * mPerMerc;
  const doneM = Math.min(totalM, agent.dist * mPerMerc);
  const progress = totalM > 0 ? doneM / totalM : 0;
  const etaSeconds = (totalM - doneM) / Math.max(0.1, agent.speedMps);
  const { lng, lat } = mercToLngLat(agent.x, agent.y);

  const rows: Array<[string, string]> =
    agent.kind === 'person'
      ? [
          ['Name', agent.name],
          ['Age', `${agent.age}`],
          ['Status', agent.status],
          ['Speed', `${agent.speedMps.toFixed(1)} m/s (${(agent.speedMps * 3.6).toFixed(1)} km/h)`],
        ]
      : [
          ['Model', agent.model],
          ['Plate', agent.plate],
          ['Driver', agent.driver],
          ['Passengers', `${agent.passengers}`],
          ['Purpose', agent.status],
          ['Speed', `${agent.speedMps.toFixed(1)} m/s (${(agent.speedMps * 3.6).toFixed(1)} km/h)`],
        ];

  return (
    <aside className={`panel ${collapsed ? 'collapsed' : ''}`}>
      <header className="panel-head">
        <button className="panel-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '‹' : '›'}
        </button>
        <span className="panel-badge" style={{ background: agent.color }} />
        <h2>{agent.kind === 'person' ? agent.name : agent.model}</h2>
        <button className="panel-close" onClick={onClose} aria-label="Deselect">
          ×
        </button>
      </header>

      {!collapsed && (
        <div className="panel-body">
          <div className="panel-kind">
            {agent.kind === 'person' ? 'Person' : 'Vehicle'} · <code>{agent.id}</code>
          </div>

          <dl>
            {rows.map(([k, v]) => (
              <div key={k} className="row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>

          <h3>Trip</h3>
          <div className="trip-bar">
            <div className="trip-fill" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
          <div className="trip-ends">
            <span>{agent.origin}</span>
            <span>{agent.destination}</span>
          </div>

          <dl>
            <div className="row">
              <dt>Progress</dt>
              <dd>{(progress * 100).toFixed(0)}%</dd>
            </div>
            <div className="row">
              <dt>Travelled</dt>
              <dd>{formatDistance(doneM)}</dd>
            </div>
            <div className="row">
              <dt>Remaining</dt>
              <dd>{formatDistance(totalM - doneM)}</dd>
            </div>
            <div className="row">
              <dt>ETA</dt>
              <dd>{formatDuration(etaSeconds)}</dd>
            </div>
            <div className="row">
              <dt>Waypoints</dt>
              <dd>{agent.path.cum.length}</dd>
            </div>
            <div className="row">
              <dt>Position</dt>
              <dd>
                {lat.toFixed(5)}, {lng.toFixed(5)}
              </dd>
            </div>
            <div className="row">
              <dt>Routing</dt>
              <dd>{agent.lastEdge != null ? 'road network' : 'procedural'}</dd>
            </div>
          </dl>

          <p className="panel-hint">
            The yellow line is the remaining route; the dashed white line is where it has been.
          </p>
        </div>
      )}
    </aside>
  );
}

function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${Math.round(s % 60)} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}
