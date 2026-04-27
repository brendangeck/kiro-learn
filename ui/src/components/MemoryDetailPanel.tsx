import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';

import type { MemoryRecord, ObservationType } from '../types/api.js';

export interface MemoryDetailPanelProps {
  memory: MemoryRecord | null;
  concept: string | null;
  memories: MemoryRecord[];
  onClose: () => void;
}

/** Map observation_type to a Cloudscape Badge color. */
const observationTypeColor: Record<ObservationType, 'blue' | 'green' | 'red' | 'grey'> = {
  tool_use: 'blue',
  decision: 'green',
  error: 'red',
  discovery: 'blue',
  pattern: 'grey',
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Detail panel that slides in from the right when a memory or concept node
 * is clicked on the graph. Overlays the graph canvas without navigating away.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export function MemoryDetailPanel({
  memory,
  concept,
  memories,
  onClose,
}: MemoryDetailPanelProps) {
  // Nothing selected — don't render
  if (!memory && !concept) return null;

  return (
    <>
      {/* Backdrop — click to dismiss (Req 6.5) */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 999,
        }}
        onClick={onClose}
      />

      {/* Panel overlay (Req 6.6 — does not navigate away from graph) */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 400,
          height: '100%',
          zIndex: 1000,
          overflowY: 'auto',
          background: '#ffffff',
          boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.15)',
        }}
      >
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <Button
                  variant="icon"
                  iconName="close"
                  ariaLabel="Close detail panel"
                  onClick={onClose}
                />
              }
            >
              {memory ? memory.title : concept ?? ''}
            </Header>
          }
        >
          {memory ? (
            <MemoryDetail memory={memory} />
          ) : concept ? (
            <ConceptDetail concept={concept} memories={memories} />
          ) : null}
        </Container>
      </div>
    </>
  );
}

/** Full memory record view (Req 6.1, 6.2). */
function MemoryDetail({ memory }: { memory: MemoryRecord }) {
  return (
    <SpaceBetween size="m">
      {/* Summary */}
      <Box>
        <Box variant="awsui-key-label">Summary</Box>
        <Box variant="p">{memory.summary}</Box>
      </Box>

      {/* Observation type — colored badge (Req 6.2) */}
      <Box>
        <Box variant="awsui-key-label">Observation Type</Box>
        <Badge color={observationTypeColor[memory.observation_type]}>
          {memory.observation_type}
        </Badge>
      </Box>

      {/* Created at — formatted timestamp (Req 6.2) */}
      <Box>
        <Box variant="awsui-key-label">Created</Box>
        <Box>{formatTimestamp(memory.created_at)}</Box>
      </Box>

      {/* Facts — bulleted list (Req 6.2) */}
      {memory.facts.length > 0 && (
        <Box>
          <Box variant="awsui-key-label">Facts</Box>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {memory.facts.map((fact, i) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
        </Box>
      )}

      {/* Concepts — badges (Req 6.2) */}
      {memory.concepts.length > 0 && (
        <Box>
          <Box variant="awsui-key-label">Concepts</Box>
          <SpaceBetween size="xs" direction="horizontal">
            {memory.concepts.map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          </SpaceBetween>
        </Box>
      )}

      {/* Files touched (Req 6.2) */}
      {memory.files_touched.length > 0 && (
        <Box>
          <Box variant="awsui-key-label">Files Touched</Box>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {memory.files_touched.map((f, i) => (
              <li key={i}>
                <Box variant="code">{f}</Box>
              </li>
            ))}
          </ul>
        </Box>
      )}

      {/* Source event IDs (Req 6.2) */}
      {memory.source_event_ids.length > 0 && (
        <Box>
          <Box variant="awsui-key-label">Source Event IDs</Box>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {memory.source_event_ids.map((id) => (
              <li key={id}>
                <Box variant="code">{id}</Box>
              </li>
            ))}
          </ul>
        </Box>
      )}
    </SpaceBetween>
  );
}

/** Concept detail view — shows concept name and related memory titles (Req 6.4). */
function ConceptDetail({
  concept,
  memories,
}: {
  concept: string;
  memories: MemoryRecord[];
}) {
  const related = memories.filter((m) => m.concepts.includes(concept));

  return (
    <SpaceBetween size="m">
      <Box>
        <Box variant="awsui-key-label">Concept</Box>
        <Badge>{concept}</Badge>
      </Box>

      <Box>
        <Box variant="awsui-key-label">
          Related Memories ({related.length})
        </Box>
        {related.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {related.map((m) => (
              <li key={m.record_id}>{m.title}</li>
            ))}
          </ul>
        ) : (
          <Box color="text-body-secondary">No memories reference this concept</Box>
        )}
      </Box>
    </SpaceBetween>
  );
}
