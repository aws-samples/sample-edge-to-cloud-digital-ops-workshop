FROM confluentinc/cp-kafka-connect:7.6.1

# Install Hudi connector with all Hadoop runtime deps into the worker classpath.
# We put them in /usr/share/java/kafka/ (the worker's main classpath) not the plugin path,
# because hadoop-common's static initializers require transitive deps to be co-visible
# and Kafka Connect's plugin classloader isolation breaks that.

ARG MAVEN=https://repo1.maven.org/maven2
ARG HUDI=0.14.1
ARG HADOOP=3.3.4
ARG AWS_SDK=1.12.648
ARG FLINK=1.17.1
ARG SCALA=2.12

USER root

RUN curl -sSfL "${MAVEN}/org/apache/hudi/hudi-kafka-connect-bundle/${HUDI}/hudi-kafka-connect-bundle-${HUDI}.jar" \
         -o /usr/share/java/kafka/hudi-kafka-connect-bundle-${HUDI}.jar && \
    curl -sSfL "${MAVEN}/org/apache/hadoop/hadoop-common/${HADOOP}/hadoop-common-${HADOOP}.jar" \
         -o /usr/share/java/kafka/hadoop-common-${HADOOP}.jar && \
    curl -sSfL "${MAVEN}/org/apache/hadoop/hadoop-auth/${HADOOP}/hadoop-auth-${HADOOP}.jar" \
         -o /usr/share/java/kafka/hadoop-auth-${HADOOP}.jar && \
    curl -sSfL "${MAVEN}/org/apache/hadoop/hadoop-client-runtime/${HADOOP}/hadoop-client-runtime-${HADOOP}.jar" \
         -o /usr/share/java/kafka/hadoop-client-runtime-${HADOOP}.jar && \
    curl -sSfL "${MAVEN}/org/apache/hadoop/hadoop-aws/${HADOOP}/hadoop-aws-${HADOOP}.jar" \
         -o /usr/share/java/kafka/hadoop-aws-${HADOOP}.jar && \
    curl -sSfL "${MAVEN}/com/amazonaws/aws-java-sdk-bundle/${AWS_SDK}/aws-java-sdk-bundle-${AWS_SDK}.jar" \
         -o /usr/share/java/kafka/aws-java-sdk-bundle-${AWS_SDK}.jar && \
    curl -sSfL "${MAVEN}/org/apache/commons/commons-configuration2/2.1.1/commons-configuration2-2.1.1.jar" \
         -o /usr/share/java/kafka/commons-configuration2-2.1.1.jar && \
    curl -sSfL "${MAVEN}/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar" \
         -o /usr/share/java/kafka/commons-lang3-3.12.0.jar && \
    curl -sSfL "${MAVEN}/commons-beanutils/commons-beanutils/1.9.4/commons-beanutils-1.9.4.jar" \
         -o /usr/share/java/kafka/commons-beanutils-1.9.4.jar && \
    curl -sSfL "${MAVEN}/commons-logging/commons-logging/1.1.3/commons-logging-1.1.3.jar" \
         -o /usr/share/java/kafka/commons-logging-1.1.3.jar && \
    curl -sSfL "${MAVEN}/com/fasterxml/woodstox/woodstox-core/5.4.0/woodstox-core-5.4.0.jar" \
         -o /usr/share/java/kafka/woodstox-core-5.4.0.jar && \
    curl -sSfL "${MAVEN}/org/codehaus/woodstox/stax2-api/4.2.1/stax2-api-4.2.1.jar" \
         -o /usr/share/java/kafka/stax2-api-4.2.1.jar && \
    curl -sSfL "${MAVEN}/org/apache/flink/flink-hadoop-compatibility_${SCALA}/${FLINK}/flink-hadoop-compatibility_${SCALA}-${FLINK}.jar" \
         -o /usr/share/java/kafka/flink-hadoop-compatibility-${FLINK}.jar

# Inject the plugin service descriptor so Kafka Connect's scanner registers HoodieSinkConnector
RUN mkdir -p /etc/kafka/connect-plugins/kafka-connect-hudi/META-INF/services && \
    ln -s /usr/share/java/kafka/hudi-kafka-connect-bundle-${HUDI}.jar \
          /etc/kafka/connect-plugins/kafka-connect-hudi/hudi-kafka-connect-bundle-${HUDI}.jar && \
    echo "org.apache.hudi.connect.HoodieSinkConnector" \
         > /etc/kafka/connect-plugins/kafka-connect-hudi/META-INF/services/org.apache.kafka.connect.sink.SinkConnector

USER appuser
