import * as contractOntology from '@marinoscar/kvox-contract/ontology';
import * as sharedOntology from '@app/shared/ontology';

// `@app/shared/ontology` is a thin re-export of `@marinoscar/kvox-contract/ontology`
// since issue #488: the two must hand out the SAME objects, not parallel copies
// (a second `ONTOLOGY` registry would silently diverge on a later edit).
describe('@app/shared/ontology re-exports the contract ontology', () => {
  it('returns the same function and registry objects', () => {
    expect(sharedOntology.computeEffectiveSchema).toBe(contractOntology.computeEffectiveSchema);
    expect(sharedOntology.ONTOLOGY).toBe(contractOntology.ONTOLOGY);
    expect(sharedOntology.buildPropsJsonSchema).toBe(contractOntology.buildPropsJsonSchema);
  });

  it('exposes the same public surface', () => {
    expect(Object.keys(sharedOntology).sort()).toEqual(Object.keys(contractOntology).sort());
  });
});
