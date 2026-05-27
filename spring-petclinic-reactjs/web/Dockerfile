FROM public.ecr.aws/docker/library/nginx:1.25-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["/bin/sh", "-c", "sed -i 's|INTERNAL_ALB_DNS_PLACEHOLDER|'\"$WAS_ALB_DNS\"'|g' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
