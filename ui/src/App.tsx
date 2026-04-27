import { useState, useEffect, useRef, useCallback } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import type { HealthzResponse } from './types/health.js';

const POLL_INTERVAL_MS = 10_000;

function MetricCard({ title, value }: { title: string; value: number }) {
  return (
    <Container header={<Header variant="h3">{title}</Header>}>
      <Box variant="awsui-key-label" fontSize="display-l" fontWeight="bold" textAlign="center">
        {value}
      </Box>
    </Container>
  );
}

export default function App() {
  const [health, setHealth] = useState<'loading' | 'ok' | 'error'>('loading');
  const [version, setVersion] = useState<string>('unknown');
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

  useEffect(() => {
    checkHealth();
    intervalRef.current = setInterval(checkHealth, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [checkHealth]);

  return (
    <>
      <TopNavigation
        identity={{ href: '/ui', title: 'kiro-learn', logo: undefined }}
        utilities={[{ type: 'button', text: `v${version}` }]}
      />
      <AppLayout
        navigationHide
        toolsHide
        content={
          <SpaceBetween size="l">
            {/* Daemon health */}
            <StatusIndicator
              type={health === 'ok' ? 'success' : health === 'error' ? 'error' : 'loading'}
            >
              {health === 'ok' ? 'Daemon healthy' : health === 'error' ? 'Daemon unreachable' : 'Checking daemon...'}
            </StatusIndicator>

            {/* Metric cards row — placeholder values */}
            <ColumnLayout columns={4}>
              <MetricCard title="Total Memories" value={0} />
              <MetricCard title="Total Events" value={0} />
              <MetricCard title="Projects" value={0} />
              <MetricCard title="Concepts" value={0} />
            </ColumnLayout>

            {/* Graph placeholder */}
            <Container header={<Header variant="h2">Memory Graph</Header>}>
              <div style={{ minHeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <SpaceBetween size="s" direction="vertical" alignItems="center">
                  <StatusIndicator type="pending">
                    Graph visualization coming soon
                  </StatusIndicator>
                </SpaceBetween>
              </div>
            </Container>
          </SpaceBetween>
        }
      />
    </>
  );
}
