import { Client } from "@elastic/elasticsearch";
import winston, { Logger } from "winston";
import { ElasticsearchTransport } from "winston-elasticsearch";

export const winstonLogger = (
  elasticsearchNode: string,
  name: string,
  level: string
): Logger => {
  // Tạo Elasticsearch client
  const esClient = new Client({
    node: elasticsearchNode,
  });

  // Định dạng index theo ngày
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const indexSuffix = `${year}.${month}.${day}`;

  // Cấu hình Elasticsearch transport
  const esTransport = new ElasticsearchTransport({
    level: level || "info",
    client: esClient,
    indexPrefix: "logs",
    indexSuffixPattern: "YYYY.MM.DD", // tạo index pattern kiểu logs-YYYY.MM.DD
    source: name,
    bufferLimit: 100,
    flushInterval: 500,
  });

  // Tạo logger với console và Elasticsearch transports
  const logger = winston.createLogger({
    level: level,
    defaultMeta: { service: name },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
      esTransport,
    ],
  });

  // Ghi log khởi tạo
  logger.info(`Logger initialized for service: ${name}`);

  return logger;
};

export const checkElasticLoggingSetup = async (
  elasticsearchNode: string
): Promise<boolean> => {
  try {
    const esClient = new Client({ node: elasticsearchNode });

    // Kiểm tra kết nối
    const health = await esClient.cluster.health({});
    console.log(`Elasticsearch health for logging: ${health.status}`);

    // Tạo ILM policy nếu chưa tồn tại
    try {
      await esClient.ilm.getLifecycle({
        name: "logs_policy",
      });
      console.log("Using existing ILM policy for logs");
    } catch (error) {
      // Policy chưa tồn tại, tạo mới
      console.log("Creating ILM policy for logs...");
      await esClient.ilm.putLifecycle({
        name: "logs_policy",
        body: {
          policy: {
            phases: {
              hot: {
                min_age: "0ms",
                actions: {
                  rollover: {
                    max_age: "7d",
                    max_size: "5gb",
                  },
                },
              },
              warm: {
                min_age: "7d",
                actions: {
                  shrink: {
                    number_of_shards: 1,
                  },
                  forcemerge: {
                    max_num_segments: 1,
                  },
                },
              },
              cold: {
                min_age: "30d",
                actions: {},
              },
              delete: {
                min_age: "90d",
                actions: {
                  delete: {},
                },
              },
            },
          },
        },
      });
      console.log("ILM policy created successfully");
    }

    // Tạo index template với ILM policy
    const templateExists = await esClient.indices
      .existsIndexTemplate({
        name: "logs_template",
      })
      .catch(() => false);

    if (!templateExists) {
      console.log("Creating index template with ILM settings...");
      await esClient.indices.putIndexTemplate({
        name: "logs_template",
        body: {
          index_patterns: ["logs-*"],
          template: {
            settings: {
              number_of_shards: 1,
              number_of_replicas: 1,
              "lifecycle.name": "logs_policy",
            },
            mappings: {
              properties: {
                "@timestamp": { type: "date" },
                message: { type: "text" },
                level: { type: "keyword" },
                service: { type: "keyword" },
              },
            },
          },
        },
      });
      console.log("Index template created successfully");
    }

    // Lấy ngày hôm nay theo định dạng YYYY.MM.DD
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const indexName = `logs-${year}.${month}.${day}`;

    // Kiểm tra và tạo index nếu chưa tồn tại
    const indexExists = await esClient.indices.exists({ index: indexName });
    if (!indexExists) {
      await esClient.indices.create({
        index: indexName,
      });
      console.log(`Created Elasticsearch index: ${indexName}`);
    }

    return true;
  } catch (error) {
    console.error("Failed to setup Elasticsearch logging:", error);
    return false;
  }
};
