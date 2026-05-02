import { useCallback, useMemo, useState } from 'react';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';

import { transform, type NodeId, type NodeKind, type ProjectInfo } from '../graph/transform.js';
import { getPackedTheme } from '../graph/theme.js';
import { CosmosGraph } from './CosmosGraph.js';
import { GraphLegend } from '../graph/GraphLegend.js';
import type { MemoryRecord } from '../types/api.js';

/**
 * Memory graph card.
 *
 * Owns its own Cloudscape Container + Header chrome (title, refresh
 * icon button in the top-right). Click routing, theme derivation, data
 * transformation, and loading/error/empty placeholders all live here.
 *
 * Refresh model: `CosmosGraph` uploads its data snapshot exactly once
 * per mount. Background polling in `App.tsx` keeps the React-side
 * `memories` array live, but the graph ignores those mid-simulation
 * updates to keep the force layout from constantly restarting. The
 * refresh button bumps `refreshKey` which, via `key={refreshKey}`,
 * unmounts the old `CosmosGraph` and mounts a new one against the
 * latest data.
 */
interface MemoryGraphProps {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  darkMode: boolean;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

export function MemoryGraph({
  memories,
  projects,
  loading,
  error,
  darkMode,
  onNodeClick,
}: MemoryGraphProps) {
  const theme = useMemo(() => getPackedTheme(darkMode), [darkMode]);
  const data = useMemo(() => transform(memories, projects, theme), [memories, projects, theme]);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleClick = useCallback(
    (id: NodeId | null, kind: NodeKind | null) => {
      if (id === null || kind === null) {
        onNodeClick(null, null);
        return;
      }
      if (kind === 'memory') {
        const recordId = id.slice('memory:'.length);
        onNodeClick(memories.find((m) => m.record_id === recordId) ?? null, null);
      } else if (kind === 'concept') {
        // Concept id shape: `concept:<namespace>:<concept>`. Split on the
        // last `:` so namespaces containing `:` round-trip correctly.
        const rest = id.slice('concept:'.length);
        const sep = rest.lastIndexOf(':');
        onNodeClick(null, sep >= 0 ? rest.slice(sep + 1) : rest);
      }
      // Project clicks: cosmos.gl handles the visual focus internally.
      // Don't open the detail panel.
    },
    [memories, onNodeClick],
  );

  const header = (
    <Header
      variant="h2"
      actions={
        <Button
          iconName="refresh"
          variant="icon"
          ariaLabel="Refresh graph"
          onClick={() => setRefreshKey((k) => k + 1)}
          data-testid="cosmos-refresh"
        />
      }
    >
      Memory Graph
    </Header>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <Spinner size="large" />
        <Box variant="p" color="text-body-secondary" margin={{ top: 's' }}>
          Loading graph...
        </Box>
      </Box>
    );
  } else if (error) {
    body = (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <StatusIndicator type="error">Failed to load memories</StatusIndicator>
      </Box>
    );
  } else if (memories.length === 0) {
    body = (
      <Box textAlign="center" padding={{ vertical: 'xxl' }} color="text-body-secondary">
        No memories yet — run some sessions to see your graph
      </Box>
    );
  } else {
    body = (
      <>
        <Box margin={{ bottom: 's' }}>
          <GraphLegend darkMode={darkMode} />
        </Box>
        <div style={{ height: 500 }}>
          <CosmosGraph
            key={refreshKey}
            data={data}
            backgroundColor={theme.backgroundColor}
            onPointClick={handleClick}
          />
        </div>
      </>
    );
  }

  return <Container header={header}>{body}</Container>;
}
