-- Base de Pagos. La app entra con un usuario común (no superusuario): le cuentan las
-- max_connections del compose (las 3 reservadas no son para ella).
CREATE USER tienda WITH PASSWORD 'tienda';
CREATE TABLE pagos (
  id      bigserial PRIMARY KEY,
  pedido  bigint      NOT NULL,
  monto   integer     NOT NULL,
  creado  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON pagos TO tienda;

-- La caja del día: todos los cobros suman a esta fila. El UPDATE la bloquea hasta el COMMIT,
-- así que la base cobra de a uno (un "cuello de botella" con capacidad fija).
CREATE TABLE caja (
  id      integer PRIMARY KEY,
  total   bigint  NOT NULL DEFAULT 0,
  cobros  bigint  NOT NULL DEFAULT 0
);
INSERT INTO caja (id) VALUES (1);
GRANT SELECT, UPDATE ON caja TO tienda;
GRANT USAGE ON SEQUENCE pagos_id_seq TO tienda;
