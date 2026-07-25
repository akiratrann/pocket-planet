import { useQuery } from '@tanstack/react-query';
import { fetchGuide } from '../data/api';
import type { Guide } from '../types';

export function useGuide(query: string) {
  return useQuery<Guide>({
    queryKey: ['guide', query.trim().toLowerCase()],
    queryFn: () => fetchGuide(query),
    enabled: query.trim().length > 0,
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}
