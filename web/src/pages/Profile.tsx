import { Link } from "react-router";
import { ApiError, sm, useQuery, type Fact } from "../api";
import { LayerStack } from "@/components/ui/layer-stack";
import { Skeleton } from "@/components/ui/shimmer-loader";
import { Empty, useApp } from "../shared";
import { stackItems } from "./Memories";

const text = (f: Fact) => (typeof f === "string" ? f : f.memory);

export function Profile() {
  const { space, version } = useApp();
  const q = useQuery(() => sm.profile(space), [space, version]);
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const p = q.data;
  const buckets = Object.entries(p?.buckets ?? {}).filter(([, v]) => v.length);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Profile</h1>
          <p>What the engine believes about you in {space}: lasting facts, and what's going on right now.</p>
        </div>
      </header>

      {missing ? (
        <div className="tray">
          <div className="card">
            <Empty art={<LayerStack items={stackItems} defaultIndex={4} />} title="Profiles aren't available yet">
              This server doesn't expose /profile. Your memories are still there.
            </Empty>
          </div>
        </div>
      ) : q.error ? (
        <div className="error-box">{q.error.message}</div>
      ) : (
        <>
          <div className="facts">
            <FactList title="Static" hint="Stays true over time" facts={p?.static} loading={q.loading && !p} />
            <FactList title="Dynamic" hint="Recent context" facts={p?.dynamic} loading={q.loading && !p} />
          </div>
          {buckets.length > 0 && (
            <div className="facts" style={{ marginTop: 16 }}>
              {buckets.map(([name, facts]) => (
                <FactList key={name} title={name[0].toUpperCase() + name.slice(1)} hint="Bucket" facts={facts} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FactList({ title, hint, facts, loading }: { title: string; hint: string; facts?: Fact[]; loading?: boolean }) {
  return (
    <div className="tray" style={{ marginTop: 0 }}>
      <div className="tray-head">
        {title}
        <span className="right" style={{ fontWeight: 400 }}>{hint}</span>
      </div>
      <div className="card">
        {loading ? (
          [0, 1, 2].map((i) => (
            <div className="fact" key={i}><Skeleton width={`${80 - i * 15}%`} height={12} radius={6} /></div>
          ))
        ) : !facts?.length ? (
          <Empty title="Nothing yet">Add a few notes and this fills in.</Empty>
        ) : (
          facts.map((f, i) =>
            typeof f === "string" ? (
              <div className="fact" key={i}>{f}</div>
            ) : (
              <Link className="fact" key={f.id} to={`/memories/${encodeURIComponent(f.id)}`}>
                {text(f)}
              </Link>
            ),
          )
        )}
      </div>
    </div>
  );
}
