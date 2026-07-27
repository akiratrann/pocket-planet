import { useQuery } from '@tanstack/react-query';
import { fetchGuide } from '../data/api';
import type { Guide } from '../types';

export function useGuide(query: string, lang = 'en') {
  return useQuery<Guide>({
    queryKey: ['guide', query.trim().toLowerCase(), lang],
    queryFn: () => fetchGuide(query, lang),
    enabled: query.trim().length > 0,
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}
