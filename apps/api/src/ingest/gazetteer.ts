/**
 * Curated vocabulary for knowledge-graph entity extraction (ML / AI / data-science heavy, since
 * arXiv/OpenAlex CS papers dominate). Each entry: canonical name + optional aliases.
 * Matching is exact on word boundaries, case-insensitive except where an alias is all-caps.
 */
export type EntityType = "method" | "model" | "dataset" | "metric" | "task";

type Entry = [canonical: string, ...aliases: string[]];

export const GAZETTEER: Record<EntityType, Entry[]> = {
  dataset: [
    ["ImageNet", "ILSVRC"], ["CIFAR-10", "CIFAR10"], ["CIFAR-100", "CIFAR100"], ["MNIST"], ["Fashion-MNIST"], ["SVHN"],
    ["MS COCO", "COCO", "MSCOCO"], ["Pascal VOC", "PASCAL VOC"], ["Cityscapes"], ["ADE20K"], ["LAION-5B", "LAION"],
    ["SQuAD"], ["GLUE"], ["SuperGLUE"], ["MMLU"], ["GSM8K"], ["HumanEval"], ["MBPP"], ["BIG-bench", "BIG-Bench"],
    ["HellaSwag"], ["TruthfulQA"], ["ARC"], ["Natural Questions", "NQ"], ["TriviaQA"], ["HotpotQA"], ["MS MARCO", "MSMARCO"],
    ["BEIR"], ["MTEB"], ["WikiText-103", "WikiText"], ["Penn Treebank", "PTB"], ["WMT14", "WMT"], ["CNN/DailyMail", "CNN/DM"],
    ["XSum"], ["LibriSpeech"], ["Common Voice"], ["AudioSet"], ["Kinetics"], ["UCF101"], ["Cora"], ["CiteSeer"], ["PubMed"],
    ["OGB", "Open Graph Benchmark"], ["QM9"], ["MIMIC-III", "MIMIC"], ["UK Biobank"], ["The Pile"], ["C4"], ["Common Crawl"],
    ["OpenWebText"], ["MovieLens"], ["Amazon Reviews"], ["Yelp"], ["IMDB"], ["SST-2", "SST"], ["CoNLL-2003", "CoNLL"],
    ["KITTI"], ["nuScenes"], ["ShapeNet"], ["CelebA"], ["FFHQ"], ["LSUN"], ["Atari", "Arcade Learning Environment"],
    ["MuJoCo"], ["D4RL"], ["ScienceQA"], ["MMMU"], ["MATH"], ["SWE-bench"], ["LongBench"], ["Chatbot Arena"],
  ],
  model: [
    ["Transformer"], ["BERT"], ["RoBERTa"], ["DistilBERT"], ["ALBERT"], ["ELECTRA"], ["DeBERTa"], ["XLNet"], ["T5"], ["BART"],
    ["GPT-2"], ["GPT-3"], ["GPT-4", "GPT-4o"], ["ChatGPT"], ["LLaMA", "Llama 2", "Llama-2", "Llama 3", "Llama-3"], ["Mistral"],
    ["Mixtral"], ["Gemini"], ["Claude"], ["PaLM"], ["Falcon"], ["Qwen"], ["DeepSeek"], ["Phi-2", "Phi-3"], ["Vicuna"],
    ["ResNet", "ResNet-50", "ResNet-101"], ["VGG", "VGG-16"], ["Inception"], ["EfficientNet"], ["MobileNet"], ["DenseNet"],
    ["Vision Transformer", "ViT"], ["Swin Transformer", "Swin"], ["CLIP"], ["DINO", "DINOv2"], ["SAM", "Segment Anything"],
    ["U-Net", "UNet"], ["YOLO"], ["Faster R-CNN"], ["Mask R-CNN"], ["DETR"], ["Stable Diffusion"], ["DALL-E", "DALL·E"],
    ["Imagen"], ["StyleGAN"], ["LSTM"], ["GRU"], ["Word2Vec"], ["GloVe"], ["fastText"], ["ELMo"], ["Sentence-BERT", "SBERT"],
    ["GCN", "Graph Convolutional Network"], ["GAT", "Graph Attention Network"], ["GraphSAGE"], ["GIN"], ["AlphaFold"],
    ["Whisper"], ["wav2vec 2.0", "wav2vec"], ["XGBoost"], ["LightGBM"], ["Random Forest"], ["Mamba"], ["RWKV"],
  ],
  method: [
    ["attention mechanism", "self-attention", "multi-head attention"], ["contrastive learning"], ["self-supervised learning"],
    ["supervised learning"], ["unsupervised learning"], ["semi-supervised learning"], ["reinforcement learning"],
    ["RLHF", "reinforcement learning from human feedback"], ["DPO", "direct preference optimization"], ["PPO", "proximal policy optimization"],
    ["fine-tuning", "finetuning", "fine tuning"], ["instruction tuning"], ["LoRA", "low-rank adaptation"], ["QLoRA"],
    ["prompt tuning"], ["prefix tuning"], ["in-context learning"], ["chain-of-thought", "chain of thought"],
    ["retrieval-augmented generation", "retrieval augmented generation", "RAG"], ["knowledge distillation", "distillation"],
    ["quantization"], ["pruning"], ["mixture of experts", "mixture-of-experts", "MoE"], ["transfer learning"], ["meta-learning"],
    ["few-shot learning"], ["zero-shot learning"], ["active learning"], ["federated learning"], ["continual learning"],
    ["data augmentation"], ["dropout"], ["batch normalization", "batch norm"], ["layer normalization"], ["weight decay"],
    ["adversarial training"], ["generative adversarial network", "GAN"], ["variational autoencoder", "VAE"], ["autoencoder"],
    ["diffusion model", "denoising diffusion", "DDPM", "score-based generative model"], ["normalizing flow"],
    ["graph neural network", "GNN"], ["message passing"], ["knowledge graph embedding"], ["topic modeling", "topic modelling", "LDA"],
    ["variational inference"], ["Bayesian optimization"], ["Markov chain Monte Carlo", "MCMC"], ["Gaussian process"],
    ["beam search"], ["dense retrieval"], ["BM25"], ["reranking", "re-ranking"], ["hybrid search"], ["vector database"],
    ["clustering"], ["dimensionality reduction"], ["UMAP"], ["t-SNE"], ["PCA", "principal component analysis"],
    ["gradient descent", "SGD", "stochastic gradient descent"], ["Adam"], ["backpropagation"], ["neural architecture search", "NAS"],
    ["curriculum learning"], ["multi-task learning"], ["domain adaptation"], ["model compression"], ["speculative decoding"],
  ],
  metric: [
    ["accuracy"], ["top-1 accuracy"], ["top-5 accuracy"], ["F1", "F1 score", "F1-score", "macro-F1"], ["precision"], ["recall"],
    ["AUC", "AUROC", "ROC-AUC"], ["mAP", "mean average precision"], ["IoU", "mIoU"], ["BLEU"], ["ROUGE", "ROUGE-L"], ["METEOR"],
    ["perplexity"], ["exact match", "EM"], ["NDCG", "nDCG"], ["MRR", "mean reciprocal rank"], ["Recall@k", "recall@k"],
    ["FID", "Fréchet Inception Distance"], ["Inception Score"], ["MSE", "mean squared error"], ["RMSE"], ["MAE"],
    ["word error rate", "WER"], ["pass@k", "pass@1"], ["latency"], ["throughput"], ["FLOPs"], ["calibration error", "ECE"],
  ],
  task: [
    ["image classification"], ["object detection"], ["semantic segmentation"], ["instance segmentation"], ["image generation"],
    ["text-to-image generation", "text-to-image"], ["machine translation"], ["question answering"], ["summarization"],
    ["sentiment analysis"], ["named entity recognition", "NER"], ["relation extraction"], ["text classification"],
    ["language modeling", "language modelling"], ["code generation"], ["speech recognition", "ASR"], ["text-to-speech"],
    ["recommendation", "recommender systems"], ["link prediction"], ["node classification"], ["graph classification"],
    ["information retrieval", "document retrieval"], ["anomaly detection"], ["time series forecasting", "forecasting"],
    ["reasoning", "mathematical reasoning"], ["visual question answering", "VQA"], ["image captioning"], ["pose estimation"],
    ["depth estimation"], ["drug discovery"], ["protein structure prediction"], ["autonomous driving"], ["robotics"],
    ["dialogue", "dialogue systems"], ["fact verification", "fact-checking"], ["hallucination detection"],
  ],
};

export interface Matcher {
  type: EntityType;
  canonical: string;
  ci: RegExp | null; // case-insensitive names ("graph neural network", "ImageNet")
  cs: RegExp | null; // short all-caps acronyms, case-sensitive ("GAN", "MSE") to avoid false hits
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ACRONYM = /^[A-Z0-9-]{2,6}$/;
const bounded = (alts: string[], flags: string) =>
  alts.length ? new RegExp(`(?<![\\w-])(?:${alts.map(esc).join("|")})(?![\\w-])`, flags) : null;

/** One matcher per canonical entity; its aliases are folded in. */
export const MATCHERS: Matcher[] = (Object.entries(GAZETTEER) as [EntityType, Entry[]][]).flatMap(([type, entries]) =>
  entries.map(([canonical, ...aliases]) => {
    const names = [canonical, ...aliases];
    return {
      type,
      canonical,
      ci: bounded(names.filter((n) => !ACRONYM.test(n)), "gi"),
      cs: bounded(names.filter((n) => ACRONYM.test(n)), "g"),
    };
  }),
);

/** Number of mentions of an entity in a text. */
export function countMentions(m: Matcher, text: string): number {
  return (m.ci ? text.match(m.ci)?.length ?? 0 : 0) + (m.cs ? text.match(m.cs)?.length ?? 0 : 0);
}
