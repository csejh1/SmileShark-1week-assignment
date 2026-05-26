FROM public.ecr.aws/docker/library/eclipse-temurin:17-jdk-jammy AS builder
WORKDIR /app
COPY . .
RUN chmod +x mvnw
# Build using maven wrapper, skipping tests for faster build in CI
RUN ./mvnw clean package -DskipTests

FROM public.ecr.aws/docker/library/eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=builder /app/target/spring-petclinic-rest-*.jar app.jar
EXPOSE 9966
ENTRYPOINT ["java", "-jar", "app.jar"]
