/** Schemas der Notizen (OpenAPI, Prüfung der Eingaben). */
import { Type, type Static } from '@sinclair/typebox';
import { Cursor, DateTime, Limit, NextCursor, Nullable, Uuid } from '../../../src/index.ts';

const Zeit = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'Uhrzeit HH:MM (24 h).', examples: ['06:00'] });
const Stufe = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], { description: 'Klassifizierung: 0 intern, 1 vertraulich, 2 streng vertraulich.' });
const Label = Type.String({ minLength: 1, maxLength: 200, description: 'Name, eindeutig in der Organisation (ohne Gross/klein).' });

export const Notiz = Type.Object({
  id: Uuid,
  label: Type.String(),
  beginn: Nullable(Zeit),
  ende: Nullable(Zeit),
  classification: Stufe,
  version: Type.Integer({ minimum: 1 }),
  createdAt: DateTime,
  createdBy: Nullable(Uuid),
  updatedAt: DateTime,
  updatedBy: Nullable(Uuid),
  can: Type.Object({ write: Type.Boolean(), delete: Type.Boolean() }, { description: 'Was die anfragende Person damit darf.' }),
}, { $id: 'Notiz', additionalProperties: false });
export type NotizOut = Static<typeof Notiz>;

export const NotizCreate = Type.Object({
  label: Label,
  beginn: Type.Optional(Nullable(Zeit)),
  ende: Type.Optional(Nullable(Zeit)),
  classification: Type.Optional(Stufe),
}, { $id: 'NotizCreate', additionalProperties: false });
export type NotizCreateIn = Static<typeof NotizCreate>;

export const NotizPatch = Type.Object({
  label: Type.Optional(Label),
  beginn: Type.Optional(Nullable(Zeit)),
  ende: Type.Optional(Nullable(Zeit)),
  classification: Type.Optional(Stufe),
}, { $id: 'NotizPatch', additionalProperties: false, minProperties: 1 });
export type NotizPatchIn = Static<typeof NotizPatch>;

export const NotizList = Type.Object({ items: Type.Array(Type.Ref('Notiz')), nextCursor: NextCursor }, { $id: 'NotizList', additionalProperties: false });

export const ListQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 200, description: 'Suche im Namen (Teilstring).' })),
  cursor: Type.Optional(Cursor),
  limit: Type.Optional(Limit),
}, { additionalProperties: false });

export const NotizVersion = Type.Object({
  version: Type.Integer(),
  action: Type.Union([Type.Literal('created'), Type.Literal('updated'), Type.Literal('deleted')]),
  label: Type.String(), beginn: Nullable(Zeit), ende: Nullable(Zeit), classification: Stufe,
  changedAt: DateTime, changedBy: Nullable(Uuid),
}, { $id: 'NotizVersion', additionalProperties: false });
export const NotizHistory = Type.Object({ items: Type.Array(Type.Ref('NotizVersion')) }, { $id: 'NotizHistory', additionalProperties: false });
