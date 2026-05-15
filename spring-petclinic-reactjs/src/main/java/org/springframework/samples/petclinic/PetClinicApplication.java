package org.springframework.samples.petclinic;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@SpringBootApplication
public class PetClinicApplication {

	// 환경변수 CORS_ALLOWED_ORIGIN 이 없으면 localhost:4444 를 기본값으로 사용
	@Value("${CORS_ALLOWED_ORIGIN:http://localhost:4444}")
	private String corsAllowedOrigin;

	public static void main(String[] args) {
		SpringApplication.run(PetClinicApplication.class, args);
	}

	@Bean
	public WebMvcConfigurer corsConfigurer() {
		return new WebMvcConfigurer() {
			@Override
			public void addCorsMappings(CorsRegistry registry) {
				registry.addMapping("/**")
						.allowedOriginPatterns(
								"http://localhost:4444",
								"http://localhost:3000",
								corsAllowedOrigin   // AWS 배포 시 CloudFront 도메인이 주입됨
						)
						.allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH")
						.allowedHeaders("*")
						.exposedHeaders("errors", "content-type");
			}
		};
	}
}
