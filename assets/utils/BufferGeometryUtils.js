/**
 * GLTFLoader 仅需 toTrianglesDrawMode（Three.js examples/jsm/utils 子集）
 * @see https://github.com/mrdoob/three.js/blob/dev/examples/jsm/utils/BufferGeometryUtils.js
 */
import {
	TriangleFanDrawMode,
	TriangleStripDrawMode,
	TrianglesDrawMode,
} from "three";

/**
 * @param {import("three").BufferGeometry} geometry
 * @param {number} drawMode
 * @returns {import("three").BufferGeometry}
 */
function toTrianglesDrawMode(geometry, drawMode) {
	if (drawMode === TrianglesDrawMode) {
		console.warn(
			"THREE.BufferGeometryUtils.toTrianglesDrawMode(): Geometry already defined as triangles.",
		);
		return geometry;
	}

	if (drawMode === TriangleFanDrawMode || drawMode === TriangleStripDrawMode) {
		let index = geometry.getIndex();

		if (index === null) {
			const indices = [];
			const position = geometry.getAttribute("position");

			if (position !== undefined) {
				for (let i = 0; i < position.count; i++) {
					indices.push(i);
				}

				geometry.setIndex(indices);
				index = geometry.getIndex();
			} else {
				console.error(
					"THREE.BufferGeometryUtils.toTrianglesDrawMode(): Undefined position attribute. Processing not possible.",
				);
				return geometry;
			}
		}

		const numberOfTriangles = index.count - 2;
		const newIndices = [];

		if (drawMode === TriangleFanDrawMode) {
			for (let i = 1; i <= numberOfTriangles; i++) {
				newIndices.push(index.getX(0));
				newIndices.push(index.getX(i));
				newIndices.push(index.getX(i + 1));
			}
		} else {
			for (let i = 0; i < numberOfTriangles; i++) {
				if (i % 2 === 0) {
					newIndices.push(index.getX(i));
					newIndices.push(index.getX(i + 1));
					newIndices.push(index.getX(i + 2));
				} else {
					newIndices.push(index.getX(i + 2));
					newIndices.push(index.getX(i + 1));
					newIndices.push(index.getX(i));
				}
			}
		}

		if (newIndices.length / 3 !== numberOfTriangles) {
			console.error(
				"THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unable to generate correct amount of triangles.",
			);
		}

		const newGeometry = geometry.clone();
		newGeometry.setIndex(newIndices);
		newGeometry.clearGroups();

		return newGeometry;
	}

	console.error(
		"THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unknown draw mode:",
		drawMode,
	);
	return geometry;
}

export { toTrianglesDrawMode };
