import { log, join } from '../helpers';
import * as tf from '../../dist/tfjs.esm.js';
import * as box from './box';
import * as util from './util';

const keypointsCount = 6;

function decodeBounds(boxOutputs, anchors, inputSize) {
  const boxStarts = tf.slice(boxOutputs, [0, 1], [-1, 2]);
  const centers = tf.add(boxStarts, anchors);
  const boxSizes = tf.slice(boxOutputs, [0, 3], [-1, 2]);
  const boxSizesNormalized = tf.div(boxSizes, inputSize);
  const centersNormalized = tf.div(centers, inputSize);
  const halfBoxSize = tf.div(boxSizesNormalized, 2);
  const starts = tf.sub(centersNormalized, halfBoxSize);
  const ends = tf.add(centersNormalized, halfBoxSize);
  const startNormalized = tf.mul(starts, inputSize);
  const endNormalized = tf.mul(ends, inputSize);
  const concatAxis = 1;
  return tf.concat2d([startNormalized, endNormalized], concatAxis);
}

export class BlazeFaceModel {
  model: any;
  anchorsData: any;
  anchors: any;
  inputSize: number;
  config: any;

  constructor(model, config) {
    this.model = model;
    this.anchorsData = util.generateAnchors(model.inputs[0].shape[1]);
    this.anchors = tf.tensor2d(this.anchorsData);
    this.inputSize = model.inputs[0].shape[2];
    this.config = config;
  }

  async getBoundingBoxes(inputImage) {
    // sanity check on input
    if ((!inputImage) || (inputImage.isDisposedInternal) || (inputImage.shape.length !== 4) || (inputImage.shape[1] < 1) || (inputImage.shape[2] < 1)) return null;
    const [batch, boxes, scores] = tf.tidy(() => {
      const resizedImage = inputImage.resizeBilinear([this.inputSize, this.inputSize]);
      // const normalizedImage = tf.mul(tf.sub(resizedImage.div(255), 0.5), 2);
      const normalizedImage = resizedImage.div(127.5).sub(0.5);
      const batchedPrediction = this.model.predict(normalizedImage);
      let batchOut;
      // are we using tfhub or pinto converted model?
      if (Array.isArray(batchedPrediction)) {
        const sorted = batchedPrediction.sort((a, b) => a.size - b.size);
        const concat384 = tf.concat([sorted[0], sorted[2]], 2); // dim: 384, 1 + 16
        const concat512 = tf.concat([sorted[1], sorted[3]], 2); // dim: 512, 1 + 16
        const concat = tf.concat([concat512, concat384], 1);
        batchOut = concat.squeeze(0);
      } else {
        batchOut = batchedPrediction.squeeze(); // when using tfhub model
      }
      const boxesOut = decodeBounds(batchOut, this.anchors, [this.inputSize, this.inputSize]);
      const logits = tf.slice(batchOut, [0, 0], [-1, 1]);
      const scoresOut = tf.sigmoid(logits).squeeze();
      return [batchOut, boxesOut, scoresOut];
    });
    const boxIndicesTensor = await tf.image.nonMaxSuppressionAsync(boxes, scores, this.config.face.detector.maxDetected, this.config.face.detector.iouThreshold, this.config.face.detector.minConfidence);
    const boxIndices = boxIndicesTensor.arraySync();
    boxIndicesTensor.dispose();
    const boundingBoxesMap = boxIndices.map((boxIndex) => tf.slice(boxes, [boxIndex, 0], [1, -1]));
    const boundingBoxes = boundingBoxesMap.map((boundingBox) => {
      const vals = boundingBox.arraySync();
      boundingBox.dispose();
      return vals;
    });

    const scoresVal = scores.dataSync();
    const annotatedBoxes: Array<{ box: any, landmarks: any, anchor: any, confidence: number }> = [];
    for (let i = 0; i < boundingBoxes.length; i++) {
      const boxIndex = boxIndices[i];
      const confidence = scoresVal[boxIndex];
      if (confidence > this.config.face.detector.minConfidence) {
        const localBox = box.createBox(boundingBoxes[i]);
        const anchor = this.anchorsData[boxIndex];
        const landmarks = tf.tidy(() => tf.slice(batch, [boxIndex, keypointsCount - 1], [1, -1]).squeeze().reshape([keypointsCount, -1]));
        annotatedBoxes.push({ box: localBox, landmarks, anchor, confidence });
      }
    }
    batch.dispose();
    boxes.dispose();
    scores.dispose();
    return {
      boxes: annotatedBoxes,
      scaleFactor: [inputImage.shape[2] / this.inputSize, inputImage.shape[1] / this.inputSize],
    };
  }
}

export async function load(config) {
  const model = await tf.loadGraphModel(join(config.modelBasePath, config.face.detector.modelPath), { fromTFHub: config.face.detector.modelPath.includes('tfhub.dev') });
  const blazeFace = new BlazeFaceModel(model, config);
  if (!model || !model.modelUrl) log('load model failed:', config.face.detector.modelPath);
  else if (config.debug) log('load model:', model.modelUrl);
  return blazeFace;
}
