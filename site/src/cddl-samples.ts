export interface CddlSample {
  name: string;
  cddl: string;
  /** Matching CDN instance; loaded into the CDN editor for a live demo. */
  cdn?: string;
}

export const CDDL_SAMPLES: CddlSample[] = [
  {
    name: 'Person struct',
    cddl: `; CDDL (RFC 8610) — the schema language for CBOR. Edit me!
person = {
  name: tstr,
  ? age: uint,
  ? email: tstr .regexp "[^@]+@[^@]+",
}`,
    cdn: `{
  "name": "Ada Lovelace",
  "age": 36,
  "email": "ada@example.org",
}`,
  },
  {
    name: 'Groups, choices & ranges',
    cddl: `reservation = [
  1*4 guests: guest,
  room: room-number,
  ? note: tstr .size (1..64),
]
guest = { name: tstr, ? vip: bool }
room-number = 100..699 / "penthouse"`,
    cdn: `[
  {"name": "Kudo"},
  {"name": "Ada", "vip": true},
  512,
  "late check-in",
]`,
  },
  {
    name: 'COSE_Sign1 (RFC 9052)',
    cddl: `COSE_Sign1 = [
  protected: bstr .cbor header_map / bstr .size 0,
  unprotected: header_map,
  payload: bstr / nil,
  signature: bstr,
]
header_map = {
  ? 1 => int / tstr,   ; alg
  ? 4 => bstr,         ; kid
  * label => any,
}
label = int / tstr`,
    cdn: `[
  / protected   / << {1: -7} >>,
  / unprotected / {4: '11'},
  / payload     / 'This is the content.',
  / signature   / h'8eb33e4ca31d1c465ab05aac34cc6b23
                    d58fef5c083106c4d25a91aef0b0117e',
]`,
  },
];

export const DEFAULT_CDDL_SAMPLE = CDDL_SAMPLES[0]!;
