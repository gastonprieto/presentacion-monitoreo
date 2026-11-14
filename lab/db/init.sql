-- Base de Pagos. La app entra con un usuario común (no superusuario): así le cuentan
-- las max_connections del compose y escalar Pagos puede quedarse sin conexiones.
CREATE USER tienda WITH PASSWORD 'tienda';
CREATE TABLE pagos (
  id      bigserial PRIMARY KEY,
  pedido  bigint      NOT NULL,
  monto   integer     NOT NULL,
  creado  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON pagos TO tienda;
GRANT USAGE ON SEQUENCE pagos_id_seq TO tienda;
