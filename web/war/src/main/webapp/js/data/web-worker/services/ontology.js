
define([
    '../util/ajax',
    '../util/memoize'
], function(ajax, memoize) {
    'use strict';

    var PARENT_CONCEPT = 'http://www.w3.org/2002/07/owl#Thing',
        ROOT_CONCEPT = 'http://lumify.io#root',
        api = {

            ontology: memoize(function() {
                return ajax('GET', '/ontology')
                    .then(function(ontology) {
                        return _.extend({}, ontology, {
                            conceptsById: _.indexBy(ontology.concepts, 'id'),
                            propertiesByTitle: _.indexBy(ontology.properties, 'title')
                        });
                    })
            }),

            properties: memoize(function() {
                return api.ontology()
                    .then(function(ontology) {
                        return {
                            list: _.sortBy(ontology.properties, 'displayName'),
                            byTitle: _.indexBy(ontology.properties, 'title'),
                            byDataType: _.groupBy(ontology.properties, 'dataType')
                        };
                    });
            }),

            concepts: memoize(function() {
                var clsIndex = 0;

                return api.ontology()
                    .then(function(ontology) {
                        return {
                            entityConcept: buildTree(
                                ontology.concepts,
                                _.findWhere(ontology.concepts, {id: PARENT_CONCEPT})
                            ),
                            forAdmin: _.chain(ontology.conceptsById)
                                .filter(onlyEntityConcepts.bind(null, ontology.conceptsById, true))
                                .map(addFlattenedTitles.bind(null, ontology.conceptsById, true))
                                .sortBy('flattenedDisplayName')
                                .value(),
                            byId: _.indexBy(ontology.concepts, 'id'),
                            byClassName: _.indexBy(ontology.concepts, 'className'),
                            byTitle: _.chain(ontology.concepts)
                                .filter(onlyEntityConcepts.bind(null, ontology.conceptsById, false))
                                .map(addFlattenedTitles.bind(null, ontology.conceptsById, false))
                                .sortBy('flattenedDisplayName')
                                .value()
                        };
                    });

                function buildTree(concepts, root) {
                    var groupedByParent = _.groupBy(concepts, 'parentConcept'),
                        findChildrenForNode = function(node) {
                            node.className = 'conceptId-' + (clsIndex++);
                            node.children = groupedByParent[node.id] || [];
                            node.children.forEach(function(child) {
                                if (!child.glyphIconHref) {
                                    child.glyphIconHref = node.glyphIconHref;
                                }
                                if (!child.displayType) {
                                    child.displayType = node.displayType;
                                }
                                if (!child.color) {
                                    if (node.color) {
                                        child.color = node.color;
                                    } else if (
                                        [
                                            'http://lumify.io/user#user',
                                            'http://lumify.io/workspace#workspace'
                                        ].indexOf(child.id) === -1
                                    ) {
                                        console.warn(
                                            'No color specified in concept hierarchy for conceptType:',
                                            child.id
                                        );
                                        child.color = 'rgb(0, 0, 0)';
                                    }
                                }
                                findChildrenForNode(child);
                            });
                        };

                    findChildrenForNode(root);

                    return root;
                }

                function onlyEntityConcepts(conceptsById, includeThing, concept) {
                    var parentConceptId = concept.parentConcept,
                        currentParentConcept = null;

                    while (parentConceptId) {
                        currentParentConcept = conceptsById[parentConceptId];
                        if (!currentParentConcept) {
                            console.error('Could not trace concept\'s lineage to ' + PARENT_CONCEPT +
                                ' could not find ' + parentConceptId, concept);
                            return false;
                        }
                        if (currentParentConcept.id === PARENT_CONCEPT) {
                            return true;
                        }
                        parentConceptId = currentParentConcept.parentConcept;
                    }

                    return includeThing && concept.id === PARENT_CONCEPT;
                }

                function addFlattenedTitles(conceptsById, includeThing, concept) {
                    var parentConceptId = concept.parentConcept,
                        currentParentConcept = null,
                        parents = [];

                    while (parentConceptId) {
                        currentParentConcept = conceptsById[parentConceptId];
                        if (includeThing) {
                            if (currentParentConcept.id === ROOT_CONCEPT) break;
                        } else {
                            if (currentParentConcept.id === PARENT_CONCEPT) break;
                        }
                        parents.push(currentParentConcept);
                        parentConceptId = currentParentConcept.parentConcept;
                    }

                    parents.reverse();
                    var leadingSlashIfNeeded = parents.length ? '/' : '',
                        flattenedDisplayName = _.pluck(parents, 'displayName')
                            .join('/') + leadingSlashIfNeeded + concept.displayName,
                        indent = flattenedDisplayName
                            .replace(/[^\/]/g, '')
                            .replace(/\//g, '&nbsp;&nbsp;&nbsp;&nbsp;');

                    return _.extend({}, concept, {
                        flattenedDisplayName: flattenedDisplayName,
                        indent: indent
                    });
                }
            }),

            relationships: memoize(function() {
                return Promise.all([api.concepts(), api.ontology()])
                    .then(function(results) {
                        var concepts = results[0],
                            ontology = results[1],
                            list = _.sortBy(ontology.relationships, 'displayName'),
                            groupedBySource = {};

                        return {
                            list: list,
                            byId: _.indexBy(ontology.relationships, 'id'),
                            byTitle: _.indexBy(ontology.relationships, 'title'),
                            groupedBySourceDestConcepts: conceptGrouping(concepts, list, groupedBySource),
                            groupedBySourceConcept: groupedBySource
                        };
                    });

                function genKey(source, dest) {
                    return [source, dest].join('>');
                }

                // Calculates cache with all possible mappings from source->dest
                // including all possible combinations of source->children and
                // dest->children
                function conceptGrouping(concepts, relationships, groupedBySource) {
                    var groups = {},
                        addToAllSourceDestChildrenGroups = function(r, source, dest) {
                            var key = genKey(source, dest);

                            if (!groups[key]) {
                                groups[key] = [];
                            }
                            if (!groupedBySource[source]) {
                                groupedBySource[source] = [];
                            }

                            groups[key].push(r);
                            if (groupedBySource[source].indexOf(dest) === -1) {
                                groupedBySource[source].push(dest);
                            }

                            var destConcept = concepts.byId[dest]
                            if (destConcept && destConcept.children) {
                                destConcept.children.forEach(function(c) {
                                    addToAllSourceDestChildrenGroups(r, source, c.id);
                                })
                            }

                            var sourceConcept = concepts.byId[source]
                            if (sourceConcept && sourceConcept.children) {
                                sourceConcept.children.forEach(function(c) {
                                    addToAllSourceDestChildrenGroups(r, c.id, dest);
                                });
                            }
                        };

                    relationships.forEach(function(r) {
                        r.domainConceptIris.forEach(function(source) {
                            r.rangeConceptIris.forEach(function(dest) {
                                addToAllSourceDestChildrenGroups(r, source, dest);
                            });
                        });
                    });

                    return groups;
                }
            })
        };

    return api;
});
