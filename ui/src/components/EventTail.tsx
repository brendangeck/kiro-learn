import Table from '@cloudscape-design/components/table';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { EventItem } from '../types/api.js';

export interface EventTailProps {
  items: EventItem[];
  total: number;
  loading: boolean;
  error: string | null;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function bodyPreview(item: EventItem): string {
  const raw = item.body.content ?? JSON.stringify(item.body);
  if (raw.length <= 100) return raw;
  return raw.slice(0, 100) + '...';
}

export default function EventTail({ items, total, loading, error }: EventTailProps) {
  if (error) {
    return (
      <Table
        header={<Header variant="h2">Recent Events</Header>}
        columnDefinitions={[]}
        items={[]}
        empty={
          <Box textAlign="center" color="text-status-error">
            <StatusIndicator type="error">{error}</StatusIndicator>
          </Box>
        }
      />
    );
  }

  return (
    <Table
      header={<Header variant="h2">Recent Events ({total} total)</Header>}
      loading={loading}
      loadingText="Loading events..."
      columnDefinitions={[
        {
          id: 'time',
          header: 'Time',
          cell: (item: EventItem) => formatTime(item.valid_time),
        },
        {
          id: 'kind',
          header: 'Kind',
          cell: (item: EventItem) => item.kind,
        },
        {
          id: 'session',
          header: 'Session',
          cell: (item: EventItem) => item.session_id.slice(0, 8),
        },
        {
          id: 'body',
          header: 'Body Preview',
          cell: (item: EventItem) => bodyPreview(item),
        },
      ]}
      items={items}
      empty={
        <Box textAlign="center" color="text-body-secondary">
          No events recorded yet
        </Box>
      }
    />
  );
}
