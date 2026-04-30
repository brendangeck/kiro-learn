import { useState, useEffect, useRef, useCallback } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Spinner from '@cloudscape-design/components/spinner';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import type { HealthzResponse } from './types/health.js';
import type { StatsResponse, EventsResponse, MemoryRecord } from './types/api.js';
import { normalizeMemoriesResponse } from './types/api.js';
import type { ProjectInfo } from './graph/transform.js';
import EventTail from './components/EventTail.js';
import { MemoryGraph } from './components/MemoryGraph.js';
import { MemoryDetailPanel } from './components/MemoryDetailPanel.js';

const POLL_INTERVAL_MS = 10_000;

function MetricCard({ title, value, loading, error: _error }: { title: string; value: number | null; loading: boolean; error: string | null }) {
  let display: React.ReactNode;
  if (value !== null) {
    display = value;
  } else if (loading) {
    display = <Spinner size="large" />;
  } else {
    display = '—';
  }

  return (
    <Container header={<Header variant="h3">{title}</Header>}>
      <Box variant="awsui-key-label" fontSize="display-l" fontWeight="bold" textAlign="center">
        {display}
      </Box>
    </Container>
  );
}

export default function App() {
  const [health, setHealth] = useState<'loading' | 'ok' | 'error'>('loading');
  const [version, setVersion] = useState<string>('unknown');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('kiro-learn-dark-mode');
    const isDark = saved === 'true';
    applyMode(isDark ? Mode.Dark : Mode.Light);
    return isDark;
  });

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [events, setEvents] = useState<EventsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);
  const [eventsLoading, setEventsLoading] = useState<boolean>(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState<boolean>(true);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);

  const [selectedMemory, setSelectedMemory] = useState<MemoryRecord | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/healthz');
      if (!res.ok) { setHealth('error'); return; }
      const data: HealthzResponse = await res.json();
      if (data.status === 'ok') {
        setHealth('ok');
        setVersion(data.version ?? 'unknown');
      } else {
        setHealth('error');
      }
    } catch {
      setHealth('error');
    }
  }, []);

  const fetchData = useCallback(async () => {
    const [statsResult, eventsResult, memoriesResult] = await Promise.allSettled([
      fetch('/v1/stats'),
      fetch('/v1/events?limit=50'),
      fetch('/v1/memories?limit=500'),
    ]);

    // Stats
    try {
      if (statsResult.status === 'fulfilled') {
        const statsRes = statsResult.value;
        if (statsRes.ok) {
          const data = await statsRes.json() as StatsResponse;
          setStats(data);
          setStatsError(null);
        } else {
          setStatsError('Failed to load stats');
        }
      } else {
        setStatsError('Failed to load stats');
      }
    } catch {
      setStatsError('Failed to load stats');
    } finally {
      setStatsLoading(false);
    }

    // Events
    try {
      if (eventsResult.status === 'fulfilled') {
        const eventsRes = eventsResult.value;
        if (eventsRes.ok) {
          const data = await eventsRes.json() as EventsResponse;
          setEvents(data);
          setEventsError(null);
        } else {
          setEventsError('Failed to load events');
        }
      } else {
        setEventsError('Failed to load events');
      }
    } catch {
      setEventsError('Failed to load events');
    } finally {
      setEventsLoading(false);
    }

    // Memories (Req 2.1, 2.2 — fetched on mount and every 10s refresh)
    try {
      if (memoriesResult.status === 'fulfilled') {
        const memoriesRes = memoriesResult.value;
        if (memoriesRes.ok) {
          const data = normalizeMemoriesResponse(await memoriesRes.json());
          setMemories(data.items);
          setMemoriesError(null);
        } else {
          setMemoriesError('Failed to load memories');
        }
      } else {
        setMemoriesError('Failed to load memories');
      }
    } catch {
      setMemoriesError('Failed to load memories');
    } finally {
      setMemoriesLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    fetchData();
    intervalRef.current = setInterval(() => {
      checkHealth();
      fetchData();
    }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [checkHealth, fetchData]);

  // Derive project info from stats for the graph (Req 3.1 — project display names)
  const projects: ProjectInfo[] = (stats?.projects ?? []).map((p) => ({
    namespace: p.namespace,
    display_name: p.display_name,
  }));

  return (
    <>
      <TopNavigation
        identity={{
          href: '/ui',
          title: 'kiro-learn',
          logo: { src: '/ui/favicon.svg', alt: 'kiro-learn' },
        }}
        utilities={[
          {
            type: 'button',
            iconName: health === 'ok' ? 'status-positive' : health === 'error' ? 'status-negative' : 'status-pending',
            text: health === 'ok' ? 'Collector Online' : health === 'error' ? 'Collector Offline' : 'Connecting…',
            disableUtilityCollapse: true,
          },
          {
            type: 'button',
            iconName: 'light-dark',
            ariaLabel: darkMode ? 'Switch to light mode' : 'Switch to dark mode',
            onClick: () => {
              const next = !darkMode;
              setDarkMode(next);
              applyMode(next ? Mode.Dark : Mode.Light);
              localStorage.setItem('kiro-learn-dark-mode', String(next));
            },
          },
          { type: 'button', text: `v${version}` },
        ]}
      />
      <AppLayout
        navigationHide
        toolsHide
        content={
          <SpaceBetween size="l">
            {/* Metric cards row */}
            <ColumnLayout columns={4}>
              <MetricCard title="Total Memories" value={stats?.total_memories ?? null} loading={statsLoading} error={statsError} />
              <MetricCard title="Total Events" value={stats?.total_events ?? null} loading={statsLoading} error={statsError} />
              <MetricCard title="Projects" value={stats?.total_projects ?? null} loading={statsLoading} error={statsError} />
              <MetricCard title="Concepts" value={stats?.total_concepts ?? null} loading={statsLoading} error={statsError} />
            </ColumnLayout>

            {/* Memory Graph (Req 4.1 — replaces "coming soon" placeholder) */}
            <Container header={<Header variant="h2">Memory Graph</Header>}>
              <MemoryGraph
                memories={memories}
                projects={projects}
                loading={memoriesLoading}
                error={memoriesError}
                darkMode={darkMode}
                onNodeClick={(memory, concept) => {
                  setSelectedMemory(memory);
                  setSelectedConcept(concept);
                }}
              />
            </Container>

            {/* Event tail */}
            <EventTail
              items={events?.items ?? []}
              total={events?.total ?? 0}
              loading={eventsLoading}
              error={eventsError}
            />
          </SpaceBetween>
        }
      />

      {/* Detail panel — slides in when a memory or concept node is clicked (Req 6.1, 6.5) */}
      <MemoryDetailPanel
        memory={selectedMemory}
        concept={selectedConcept}
        memories={memories}
        onClose={() => {
          setSelectedMemory(null);
          setSelectedConcept(null);
        }}
      />
    </>
  );
}
