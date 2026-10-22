FROM ruby:3.3-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY Gemfile ./
RUN bundle install --without development test
COPY . .
ENV RACK_ENV=production PORT=10000
EXPOSE 10000
CMD ["sh", "-c", "bundle exec puma -p ${PORT} -e production config.ru"]
