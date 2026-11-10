import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

// Contango fork (patch 38): who works when and who is away.

export const availabilityKeys = {
  all: (wsId: string) => ["availability", wsId] as const,
};

export function availabilityOptions(wsId: string) {
  return queryOptions({
    queryKey: availabilityKeys.all(wsId),
    queryFn: () => api.getAvailability(30),
    refetchOnMount: "always",
  });
}

function useInvalidate(wsId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: availabilityKeys.all(wsId) });
}

export function useAddMyTimeOff(wsId: string) {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: (input: { starts_on: string; ends_on?: string; half_day?: boolean; label?: string }) =>
      api.addMyTimeOff(input),
    onSettled: invalidate,
  });
}

export function useDeleteMyTimeOff(wsId: string) {
  const invalidate = useInvalidate(wsId);
  return useMutation({ mutationFn: (id: string) => api.deleteMyTimeOff(id), onSettled: invalidate });
}

export function useUpdateMyAvailability(wsId: string) {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: (input: { backup_user_id?: string; personal_ical_url?: string }) => api.updateMyAvailability(input),
    onSettled: invalidate,
  });
}
