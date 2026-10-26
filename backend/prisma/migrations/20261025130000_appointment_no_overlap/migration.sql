-- Garantia no banco: um barbeiro nunca tem dois agendamentos ATIVOS sobrepostos,
-- mesmo que dois pedidos cheguem ao mesmo tempo ou algum código esqueça a trava.
-- (A aplicação já serializa por barbeiro com pg_advisory_xact_lock; isto é a defesa final.)
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_no_overlap"
  EXCLUDE USING gist (
    "barberId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (status IN ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'));
